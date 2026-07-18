import { FastifyReply } from 'fastify';

export class SSEWriter {
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(private reply: FastifyReply) {}

  // Add missing Content-Encoding and Cache-Control headers per arch M5
  setupHeaders(): void {
    this.reply.raw.setHeader('Content-Type', 'text/event-stream;charset=utf-8');
    this.reply.raw.setHeader('Cache-Control', 'no-cache,no-transform');
    this.reply.raw.setHeader('Connection', 'keep-alive');
    this.reply.raw.setHeader('Content-Encoding', 'identity');
    this.reply.raw.setHeader('X-Accel-Buffering', 'no');
  }

  // Write a data chunk
  async writeChunk(data: any): Promise<void> {
    if (this.reply.raw.destroyed) return;
    const chunk = `data: ${JSON.stringify(data)}\n\n`;
    this.reply.raw.write(chunk);
    // Flush the response to ensure immediate delivery

  }

  // Write a final chunk with additional data (like usage info)
  async writeFinal(finalData: any): Promise<void> {
    const chunk = `data: ${JSON.stringify(finalData)}\n\n`;
    this.reply.raw.write(chunk);
    // Flush the response

  }

  // Write an error message
  async writeError(error: string): Promise<void> {
    const errorData = {
      error: error
    };
    const chunk = `data: ${JSON.stringify(errorData)}\n\n`;
    this.reply.raw.write(chunk);
    // Flush the response

  }

  // Start sending periodic heartbeats (to keep connection alive)
  startHeartbeats(intervalMs: number = 30000): void {
    this.heartbeatInterval = setInterval(() => {
      // Send empty data heartbeat (not comment line, for proxy compatibility per arch M5)
      if (!this.reply.raw.destroyed) {
        this.reply.raw.write('data: \n\n');
      }
    }, intervalMs);
  }

  // Stop heartbeats
  stopHeartbeats(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // Close the connection
  close(): void {
    this.stopHeartbeats();
    if (!this.reply.raw.destroyed) {
      this.reply.raw.end();
    }
  }
}
