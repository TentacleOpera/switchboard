import * as ts from 'typescript';
import * as path from 'path';

interface ServiceNode {
  id: string;
  name: string;
  filePath: string;
  imports: string[];
  exports: string[];
}

export interface DependencyGraph {
  nodes: Map<string, ServiceNode>;
  edges: Array<{ from: string; to: string; type: 'import' | 'extends' | 'implements' }>;
}

export class ArchitectureAnalyzer {
  private program: ts.Program;
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    const configPath = ts.findConfigFile(
      rootPath,
      ts.sys.fileExists,
      'tsconfig.json'
    );
    
    if (!configPath) {
      throw new Error('tsconfig.json not found');
    }

    // Read and parse tsconfig properly
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(`Failed to read tsconfig: ${configFile.error.messageText}`);
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath)
    );

    this.program = ts.createProgram(
      parsed.fileNames,       // Correct: list of source file paths from tsconfig
      parsed.options          // Correct: parsed compiler options
    );
  }

  analyze(focusPath?: string, maxNodes: number = 50): DependencyGraph {
    const graph: DependencyGraph = { nodes: new Map(), edges: [] };
    const sourceFiles = this.program.getSourceFiles();

    for (const sourceFile of sourceFiles) {
      const filePath = sourceFile.fileName;
      
      // Filter by focus path if provided
      if (focusPath && !filePath.includes(focusPath)) {
        continue;
      }

      // Identify service classes
      const services = this.extractServices(sourceFile);
      
      for (const service of services) {
        if (graph.nodes.size >= maxNodes) break;
        
        graph.nodes.set(service.id, service);
        
        // Extract dependencies
        const dependencies = this.extractDependencies(sourceFile, service);
        for (const dep of dependencies) {
          graph.edges.push({
            from: service.id,
            to: dep,
            type: 'import'
          });
        }
      }
    }

    return graph;
  }

  private extractServices(sourceFile: ts.SourceFile): ServiceNode[] {
    const services: ServiceNode[] = [];
    
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const name = node.name?.getText() || 'Anonymous';
        const isService = name.endsWith('Service') || 
                         node.heritageClauses?.some(h => 
                           h.types.some(t => t.getText().includes('Service'))
                         );
        
        if (isService) {
          services.push({
            id: this.generateId(sourceFile.fileName, name),
            name,
            filePath: sourceFile.fileName,
            imports: [],
            exports: []
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return services;
  }

  private extractDependencies(sourceFile: ts.SourceFile, service: ServiceNode): string[] {
    const dependencies: string[] = [];
    
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : node.moduleSpecifier?.getText().replace(/['"]/g, '');
        
        // Only track internal dependencies (not node_modules)
        if (!moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/')) {
          return;
        }

        // Resolve relative path to absolute
        const resolvedPath = path.resolve(path.dirname(sourceFile.fileName), moduleSpecifier);
        dependencies.push(this.generateId(resolvedPath, ''));
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return dependencies;
  }

  private generateId(filePath: string, name: string): string {
    const relativePath = path.relative(this.rootPath, filePath);
    const base = relativePath.replace(/\.(ts|js)$/, '').replace(/\//g, '_');
    return name ? `${base}_${name}` : base;
  }
}
