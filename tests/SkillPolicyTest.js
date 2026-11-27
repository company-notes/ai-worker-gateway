import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const skillURL = new URL('../.agents/skills/session-router/SKILL.md', import.meta.url);
const guideURL = new URL('../docs/openmausbot-setup.md', import.meta.url);

test('Session Router skill is discoverable for a new marketing work assignment, not only MCP-specific requests', async () => {
    const source = (await readFile(skillURL, 'utf8')).replace(/\r\n/g, '\n');
    const header = source.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(header, 'Skill must have frontmatter for real skill discovery');
    assert.match(header[1], /^name: session-router$/m);
    assert.match(header[1], /description:.*行銷分析.*AI Worker Gateway MCP/);
    assert.match(source, /先使用 Gateway MCP 的唯讀工具核對現有 Job 與 Workspace/);
    assert.match(source, /優先先不傳 `modelSelection`/);
    assert.match(source, /不得自行挑選另一個 `modelSelection`/);
    assert.match(source, /沿用助理本身的模型/);
    assert.match(source, /source=explicit/);
    assert.match(source, /Fleet Host／Project 預設時，應省略模型參數/);
    assert.match(source, /無法確定或不相容時詢問使用者選哪個/);
    assert.match(source, /不要先呼叫本機.*mkdir/);
    assert.match(source, /如果這個 Bot 的 Gateway MCP 沒有啟用/);
    assert.match(source, /絕對不要問一般使用者「要不要 Commit？」/);
    assert.match(source, /worker_delivery_link/);
    assert.match(source, /worker_delivery_open/);
    assert.match(source, /folderPath/);
    assert.match(source, /不要把取得 HTTP URL 當成必要步驟/);
    assert.match(source, /worker_notification_status/);
    assert.match(source, /首次連接 Worker 與自動完成通知一併授權/);
    assert.match(source, /不另外詢問要不要啟用通知/);
    assert.match(source, /自己的 Bot ID/);
    assert.match(source, /Agent Address/);
    assert.match(source, /不同 Bot 可以共享 Worker/);
    assert.match(source, /只有接收端已建立並核對後/);
    assert.match(source, /worker_provider_pair/);
    assert.match(source, /registered=true/);
    assert.match(source, /enabled=true/);
    assert.match(source, /notificationBound=true/);
    assert.match(source, /不需要另外安裝 Nuwa Agent Relay Skill/);
    assert.match(source, /schedule_list/);
    assert.match(source, /schedule_create/);
    assert.match(source, /on: \{ webhook: true \}/);
    assert.match(source, /每次新派工與續作必須傳入自己的/);
    assert.match(source, /原版 Fleet 呼叫前移除此欄位/);
    assert.doesNotMatch(source, /第一次交辦先實際派工/);
    assert.match(source, /不以 Job ID、Host、Workspace/);
});

test('Windows installer documentation uses the actual Fleet config location and explains explicit model precedence', async () => {
    const guide = await readFile(new URL('../docs/windows-install.md', import.meta.url), 'utf8');
    assert.match(guide, /T3FleetGateway.*config[.]json/);
    assert.match(guide, /provision_model_selection/);
    assert.match(guide, /source=explicit/);
    assert.match(guide, /Fleet Host.*defaultModelSelection/);
});

test('OpenMausBot installation acceptance distinguishes a file path from an enabled skill and checks MCP first', async () => {
    const guide = await readFile(guideURL, 'utf8');
    assert.match(guide, /Bot Settings → Skills/);
    assert.match(guide, /貼入整份.*SKILL\.md.*不是.*檔案路徑/);
    assert.match(guide, /Tools → Access → MCP servers/);
    assert.match(guide, /第一個實際工作工具.*Gateway/);
    assert.match(guide, /Pilot-only Fleet 權限阻斷/);
});
