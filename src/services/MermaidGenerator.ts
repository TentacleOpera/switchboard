import * as path from 'path';
import { DependencyGraph } from './ArchitectureAnalyzer';

export interface DiagramOptions {
  type: 'flowchart' | 'sequence' | 'component';
  maxNodes: number;
  detailLevel: 'summary' | 'detailed';
}

export class MermaidGenerator {
  generate(graph: DependencyGraph, options: DiagramOptions): string {
    switch (options.type) {
      case 'flowchart':
        return this.generateFlowchart(graph, options);
      case 'sequence':
        return this.generateSequence(graph, options);
      case 'component':
        return this.generateComponent(graph, options);
      default:
        throw new Error(`Unsupported diagram type: ${options.type}`);
    }
  }

  private generateFlowchart(graph: DependencyGraph, options: DiagramOptions): string {
    let mermaid = 'graph TD\n';
    
    // Add nodes
    for (const [id, node] of graph.nodes) {
      const label = options.detailLevel === 'summary' 
        ? node.name 
        : `${node.name}\\n${node.filePath}`;
      mermaid += `  ${id}["${label}"]\n`;
    }

    // Add edges
    for (const edge of graph.edges) {
      if (graph.nodes.has(edge.from) && graph.nodes.has(edge.to)) {
        mermaid += `  ${edge.from} --> ${edge.to}\n`;
      }
    }

    return this.validateAndWrap(mermaid);
  }

  private generateSequence(graph: DependencyGraph, options: DiagramOptions): string {
    let mermaid = 'sequenceDiagram\n';
    
    // Add participants
    for (const [id, node] of graph.nodes) {
      mermaid += `  participant ${id} as ${node.name}\n`;
    }

    // Add interactions based on edges
    for (const edge of graph.edges) {
      if (graph.nodes.has(edge.from) && graph.nodes.has(edge.to)) {
        const fromNode = graph.nodes.get(edge.from)!;
        const toNode = graph.nodes.get(edge.to)!;
        mermaid += `  ${fromNode.name}->>${toNode.name}: uses\n`;
      }
    }

    return this.validateAndWrap(mermaid);
  }

  private generateComponent(graph: DependencyGraph, options: DiagramOptions): string {
    let mermaid = 'graph LR\n';
    
    // Group by directory for summary view
    const groups = new Map<string, string[]>();
    
    for (const [id, node] of graph.nodes) {
      const dir = path.dirname(node.filePath);
      if (!groups.has(dir)) {
        groups.set(dir, []);
      }
      groups.get(dir)!.push(id);
    }

    // Add grouped nodes
    for (const [dir, nodeIds] of groups) {
      const dirName = path.basename(dir);
      mermaid += `  subgraph ${dirName}\n`;
      for (const nodeId of nodeIds) {
        const node = graph.nodes.get(nodeId)!;
        mermaid += `    ${nodeId}[${node.name}]\n`;
      }
      mermaid += `  end\n`;
    }

    // Add edges
    for (const edge of graph.edges) {
      if (graph.nodes.has(edge.from) && graph.nodes.has(edge.to)) {
        mermaid += `  ${edge.from} --> ${edge.to}\n`;
      }
    }

    return this.validateAndWrap(mermaid);
  }

  private validateAndWrap(mermaid: string): string {
    // Basic syntax validation
    if (!mermaid.startsWith('graph') && !mermaid.startsWith('sequenceDiagram')) {
      console.warn('Invalid Mermaid syntax detected');
      throw new Error('Invalid Mermaid syntax');
    }

    return mermaid; // Return raw mermaid for rendering
  }
}
