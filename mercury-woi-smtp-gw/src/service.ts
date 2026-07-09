/**
 * Mercury WOI SMTP Gateway Service
 * 
 * Standalone service that runs an SMTP/POP3 gateway for Mercury's Web Order Interface.
 * Accepts WOI emails over SMTP, queues them locally, and serves them via POP3 for Mercury to collect.
 * Optionally forwards accepted messages to an external mailbox.
 */

import { loadConfig, getGatewayConfig } from './config';
import { startSmtpServer, startPop3Server } from './local-relay';

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const gateway = config.gateway;

    console.log('[WOI-GW] Mercury WOI SMTP Gateway starting…');
    console.log(`[WOI-GW] Config directory: ${process.env['WOI_GATEWAY_CONFIG_DIR'] || 'default'}`);

    // Start SMTP server (accepts WOI emails from fax parser or other sources)
    const smtpServer = await startSmtpServer(gateway.smtpPort, gateway.bindAddress);
    console.log(`[WOI-GW] SMTP server listening on ${gateway.bindAddress}:${gateway.smtpPort}`);

    // Start POP3 server (Mercury polls this for queued orders)
    const pop3Server = await startPop3Server(gateway.pop3Port, gateway.bindAddress);
    console.log(`[WOI-GW] POP3 server listening on ${gateway.bindAddress}:${gateway.pop3Port}`);

    // Optional external mailbox forwarding
    if (gateway.forwardEnabled) {
      console.log(`[WOI-GW] Message forwarding enabled to: ${gateway.forwardToAddress}`);
    } else {
      console.log('[WOI-GW] Message forwarding disabled');
    }

    console.log('[WOI-GW] Service ready. Press Ctrl+C to stop.');

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      console.log('[WOI-GW] SIGTERM received, shutting down…');
      smtpServer.close();
      pop3Server.close();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('[WOI-GW] SIGINT received, shutting down…');
      smtpServer.close();
      pop3Server.close();
      process.exit(0);
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[WOI-GW] Fatal error: ${error}`);
    process.exit(1);
  }
}

main();
