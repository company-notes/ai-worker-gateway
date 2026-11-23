# Migration from the private AI Team Architecture workspace

The private `company-notes/ai-team-architecture` repository remains the source of company-level process, Wekan/ERPNext/Trac boundaries, decisions, and incident evidence. This public repository owns Worker Gateway code, its automated tests, deployable scripts and generic extension architecture.

The historical Windows PowerShell scripts are **not present in the current tree**. Their versions remain available in Git history, including the older private architecture repository. They were removed deliberately to avoid parallel, obsolete copies. The old installer downloaded a moving `main.zip` and patched upstream TypeScript; it is **not** the AI Worker Gateway installation process. Modern deployment uses an independently pinned, unmodified upstream and its documented interfaces. No existing host is changed by publishing or cloning this repository.

Do not move private employee/company work records, credentials, local `config.json`, databases, authentication tokens, or the proprietary coding/testing guide attachments to this public repository.

The former architecture-only repository should link here for executable sources and keep historical commits and tests for traceability.
