import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const skillURL = new URL('../.agents/skills/session-router/SKILL.md', import.meta.url);
const guideURL = new URL('../docs/openmausbot-setup.md', import.meta.url);

test('Session Router skill is discoverable for a new marketing work assignment, not only MCP-specific requests', async () => {
    const source = await readFile(skillURL, 'utf8');
    const header = source.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(header, 'Skill must have frontmatter for real skill discovery');
    assert.match(header[1], /^name: session-router$/m);
    assert.match(header[1], /description:.*行銷素材.*先啟用本 Skill/);
    assert.match(source, /先使用 Gateway MCP 的唯讀工具核對現有 Job 與 Workspace/);
    assert.match(source, /不要先呼叫本機.*mkdir/);
    assert.match(source, /如果這個 Bot 的 Gateway MCP 沒有啟用/);
});

test('OpenMausBot installation acceptance distinguishes a file path from an enabled skill and checks MCP first', async () => {
    const guide = await readFile(guideURL, 'utf8');
    assert.match(guide, /Bot Settings → Skills/);
    assert.match(guide, /貼入整份.*SKILL\.md.*不是.*檔案路徑/);
    assert.match(guide, /Tools → Access → MCP servers/);
    assert.match(guide, /第一個實際工作工具.*Gateway/);
    assert.match(guide, /Pilot-only Fleet 權限阻斷/);
});
