import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAiConfig } from './aiConfig.js';

for (const [provider, keyName] of [
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY']
] as const) {
  test(`loads ${provider} configuration and only requires its selected key`, () => {
    const config = loadAiConfig({
      AI_PROVIDER: provider,
      [`${provider.toUpperCase()}_MODEL`]: 'provider/model-name',
      [keyName]: 'secret'
    });
    assert.equal(config.provider, provider);
    assert.equal(config.apiKey, 'secret');
    assert.equal(config.model, 'provider/model-name');
    assert.equal(config.maxOutputTokens, 1000);
  });
}

test('rejects unsupported providers and missing selected-provider credentials', () => {
  assert.throws(() => loadAiConfig({ AI_PROVIDER: 'other', AI_MODEL: 'model' }), /AI_PROVIDER/);
  assert.throws(() => loadAiConfig({ AI_PROVIDER: 'openai', OPENAI_MODEL: 'model' }), /OPENAI_API_KEY/);
  assert.throws(() => loadAiConfig({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'key' }), /AI_MODEL/);
});

test('AI_MODEL overrides the selected provider model for backward compatibility', () => {
  const config = loadAiConfig({
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_MODEL: 'claude-sonnet-5',
    AI_MODEL: 'custom-model'
  });
  assert.equal(config.model, 'custom-model');
});
