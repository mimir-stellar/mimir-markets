const fs = require('fs');
const path = require('path');
const p = path.resolve('app/api/agents/v1/[action]/route.ts');
let content = fs.readFileSync(p, 'utf8');

const replacement1 = 
      const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : undefined;
      const record: AgentApiKeyRecord = {
        keyId: randomUUID(), agentId: agent.agentId, keyHash: hashApiKey(key),
        keyPrefix: apiKeyPrefix(key), label: String(body.label ?? \\"\\").slice(0, 80),
        createdAt: Date.now(), expiresAt, scopes,
      };
;
content = content.replace(/const record: AgentApiKeyRecord = \{[\\s\\S]*?createdAt: Date\.now\(\), expiresAt,\\s*\};/, replacement1.trim());

const replacement2 = 
      const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : undefined;
      const newRecord: AgentApiKeyRecord = {
        keyId: randomUUID(), agentId: agent.agentId, keyHash: hashApiKey(newKey),
        keyPrefix: apiKeyPrefix(newKey), label: String(body.label ?? \\"\\").slice(0, 80),
        createdAt: Date.now(), scopes,
      };
;
content = content.replace(/const newRecord: AgentApiKeyRecord = \{[\\s\\S]*?createdAt: Date\.now\(\),\\s*\};/, replacement2.trim());

fs.writeFileSync(p, content);
