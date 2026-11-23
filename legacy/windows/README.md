# Historical Windows scripts (migration archive)

These scripts are preserved from the private AI Team Architecture repository for migration and incident traceability. They were written for an earlier direct T3 Fleet Gateway Windows installation; they are **not** the installer for the new AI Worker Gateway extension.

The old installer downloads upstream `main.zip` and modifies upstream TypeScript for Windows ACL handling. That behavior conflicts with the new upstream-is-untouched contract, so **do not run these scripts as the new installation procedure**. Do not install them on production/customer machines without a separate security, version-pinning and Windows acceptance review.

Existing machines should not be uninstalled or reconfigured simply because code was moved to this public repository. See [migration notes](../../docs/migration.md) and [architecture](../../docs/architecture.md). The original commit history is retained in the private repository.
