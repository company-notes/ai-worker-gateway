# Zero-context AI assistant acceptance: automatic task delegation

This is the actual product requirement: a **brand-new assistant with no access to prior chats, documentation, or local T3 details** must accept a natural-language request such as "I need a marketing analytics tool" and dispatch it through the **single** AI Worker Gateway MCP endpoint.

## One-time operator setup (not something every new assistant must know)

1. Start/keep the original T3 Fleet Gateway at port 3790 and the original T3 Background Service at 3773. The wrapper listens at 3791; do not uninstall any of these. The assistant connects **only to 3791**.
2. Provide one authorized **general-purpose execution destination**. Choose either:
   - **Persistent work:** create/register a dedicated T3 project in the original supported system, configure it as a Fleet alias such as `general-work`, check its model, Git/workspace mode and `allowWorkStart`, then set `AWG_GENERAL_PROJECT=general-work` in the wrapper's launch environment; or
   - **One-off scratch work:** configure an official, verified `hosts[].defaultProject` scratch alias with `workspaceMode: "scratch"` and pinned real T3 scratch project id. The upstream must support this capability. See [the official upstream instructions](https://github.com/boundsj/t3-fleet-gateway/blob/main/docs/configuration.md#no-named-project).
3. Grant **the wrapper's upstream Fleet client** Operate access to that destination, and keep the assistant's distinct inbound `AWG_CLIENT_TOKEN` unchanged. Do not give the assistant the upstream Fleet token.
4. Restart **only 3791** after changing `AWG_GENERAL_PROJECT` or `AWG_UPSTREAM_TOKEN`. It should retain the existing 3790/3773 services and data.

Without one of these destinations the gateway must **refuse** arbitrary work rather than use an unrelated `pilot`, FileShare or ffl-mcp project. `worker_workspace_prepare` alone is **not** sufficient: it never registers a T3 Project.

## Blind test: do NOT preload the agent with special instructions

Create a fresh agent or fresh conversation. Its entire setup should be one MCP connection to `http://127.0.0.1:3791/mcp` using its inbound client bearer. Do **not** load the old private conversation, paste this guide into the agent, install the repo Skill, configure the original 3790 MCP, or mention T3. It should discover the workflow from MCP tool descriptions and server initialize instructions.

### Scenario A — new unrelated marketing task

Say only:

> 幫我做一個行銷成效追蹤工具，可以匯入每週的活動數據、計算轉換率，最後給我一份能查看的成果。

Expected:
- Agent discovers `worker_task_plan` / `worker_task_start` on its own.
- Plan chooses only an authorized general-work alias or one verified scratch default; **never** the unrelated `pilot` merely because it is the only configured alias.
- Agent starts one fresh `work_start` with a new `requestId`, returns the real new Job ID and follows `work_status` / `work_messages`.
- Check the delivered files or report, not just an `idle` state. Missing upstream model, policy, authorization or workspace is a **failure**, not something the assistant may invent.

### Scenario B — continuation

Then say:

> 剛才那個工具再加上 CSV 匯出功能。

Expected: same Job ID / T3 thread; `work_continue`, not a second `worker_task_start`. If several jobs match, assistant must ask which one.

### Scenario C — separate unrelated job

Then say:

> 另外幫我規劃一支 30 秒的產品介紹短影片，交付拍攝腳本和分鏡建議。

Expected: a **different Job ID**; it can reuse the authorized general execution workspace. Do not create a new T3 Project simply because the category is marketing versus video; a company Task/Card and T3 Project are different entities.

### Scenario D — ambiguous work and no default

Remove the default setting in a separate test instance, leaving only the Pilot alias. A new marketing job should yield a clear **blocked** plan requiring the one-time general-work / scratch setup, and must create **no upstream Job**. An assistant asked "繼續昨天那個工作" when several jobs match must clarify rather than randomly continue one.

## Pass / fail

A pass is *not* merely that the assistant can see `work_start`. The new assistant must autonomously discover the route, safely start a genuinely new unrelated job, preserve ID on follow-up, distinguish a separate new job, and verify work output **through 3791**. A blocked plan is safe but means full hands-off job dispatch **has not yet passed** on that machine.

The current implementation resolves only **explicit project aliases or one operator-configured general destination**. It does not semantically pick among many project descriptions, create a missing T3 project, or integrate company Card/Ticket routing; those are separate milestones. We must not claim a full zero-touch company dispatcher until those are built and tested.
