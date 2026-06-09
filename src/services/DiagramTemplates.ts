export const DiagramTemplates = {
  serviceLayer: {
    description: 'Standard service layer architecture',
    template: `graph TD
  A[Controller] --> B[Service]
  B --> C[Repository]
  C --> D[Database]
  B --> E[External API]
`
  },
  
  eventDriven: {
    description: 'Event-driven architecture',
    template: `graph LR
  A[Producer] --> B[Event Bus]
  B --> C[Consumer 1]
  B --> D[Consumer 2]
`
  },
  
  microservices: {
    description: 'Microservices communication',
    template: `graph TD
  A[Service A] --> B[API Gateway]
  B --> C[Service B]
  B --> D[Service C]
  C --> E[Database 1]
  D --> F[Database 2]
`
  }
};
