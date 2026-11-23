# Migration from the private AI Team Architecture workspace

The private `company-notes/ai-team-architecture` repository remains the source of company-level process, Wekan/ERPNext/Trac boundaries, decisions, and incident evidence. This public repository owns Worker Gateway code, its automated tests, deployable scripts and generic extension architecture.

The historical Windows PowerShell scripts were copied under `legacy/windows/` to retain a reproducible migration trail. **They are not the installation path for this new architecture.** The old installer downloads a moving `main.zip` and patches upstream TypeScript. It is quarantined as historical material only; do not run it as an AI Worker Gateway installer. Modern deployment should install T3 Fleet Gateway from an independently pinned, unmodified source and configure it via its documented interfaces. No existing host is changed by publishing this repository.

Do not move private employee/company work records, credentials, local `config.json`, databases, authentication tokens, or the proprietary coding/testing guide attachments to this public repository.

The former architecture-only repository should link here for executable sources and keep historical commits and tests for traceability.
