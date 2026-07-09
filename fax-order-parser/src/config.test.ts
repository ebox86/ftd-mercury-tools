const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG, resolveMailGatewayConfig, resolveMailboxTargets } = require('./config');

test('resolveMailGatewayConfig prefers the explicit mail gateway settings', () => {
  const config = {
    ...DEFAULT_CONFIG,
    mailGateway: {
      ...DEFAULT_CONFIG.mailGateway,
      enabled: true,
      smtpPort: 2526,
      pop3Port: 1111,
      bindAddress: '127.0.0.1',
      mode: 'built-in-relay',
    },
    localRelay: {
      ...DEFAULT_CONFIG.localRelay,
      enabled: true,
      smtpPort: 2525,
      pop3Port: 1110,
    },
  };

  const resolved = resolveMailGatewayConfig(config);

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.smtpPort, 2526);
  assert.equal(resolved.pop3Port, 1111);
  assert.equal(resolved.bindAddress, '127.0.0.1');
  assert.equal(resolved.forwardToAddress, 'your-gmail-address@gmail.com');
});

test('resolveMailGatewayConfig falls back to localRelay defaults when mailGateway is absent', () => {
  const config = {
    ...DEFAULT_CONFIG,
    mailGateway: undefined,
    localRelay: {
      ...DEFAULT_CONFIG.localRelay,
      enabled: true,
      smtpPort: 2527,
      pop3Port: 1112,
    },
  };

  const resolved = resolveMailGatewayConfig(config);

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.smtpPort, 2527);
  assert.equal(resolved.pop3Port, 1112);
  assert.equal(resolved.mode, 'built-in-relay');
});

test('resolveMailboxTargets preserves the primary and error mailbox addresses', () => {
  const config = {
    ...DEFAULT_CONFIG,
    email: {
      ...DEFAULT_CONFIG.email,
      recipientAddress: 'woi-inbox@example.com',
      errorRecipientAddress: 'woi-error@example.com',
    },
  };

  const resolved = resolveMailboxTargets(config);

  assert.equal(resolved.primary, 'woi-inbox@example.com');
  assert.equal(resolved.error, 'woi-error@example.com');
});
