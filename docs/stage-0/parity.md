# Parity and pre-automation acceptance checklist

Unchecked = not implemented or verified. Cross-reference the separate route and permission inventories; add newly discovered upstream behaviors here and resolve discrepancies before approval. Profiles and visual requirements are project gates, not upstream feature claims. Public status and other automation are explicitly deferred.

## Identity and account

- [ ] Login
- [ ] Logout
- [ ] Forgot password
- [ ] Reset password
- [ ] TOTP setup
- [ ] TOTP challenge
- [ ] TOTP recovery codes
- [ ] Disable 2FA
- [ ] Profile
- [ ] Email change
- [ ] Password change
- [ ] Client API key create
- [ ] Client API key list/revoke
- [ ] SSH key add/list/remove
- [ ] Account activity
- [ ] Session expiry

## Client servers

- [ ] Server list (owned/shared/admin visibility)
- [ ] Server detail
- [ ] Console output/reconnect
- [ ] Live resource stats
- [ ] Send command
- [ ] Start
- [ ] Stop
- [ ] Restart
- [ ] Kill
- [ ] File list/navigation
- [ ] File edit
- [ ] File create
- [ ] Folder create
- [ ] Upload
- [ ] Download
- [ ] Rename/move
- [ ] Copy
- [ ] Compress
- [ ] Extract
- [ ] Delete
- [ ] Chmod
- [ ] Remote pull
- [ ] Create database
- [ ] List databases
- [ ] View database credentials
- [ ] Rotate database password
- [ ] Delete database
- [ ] List backups
- [ ] Create local backup
- [ ] Create S3-compatible backup
- [ ] Download backup
- [ ] Lock/unlock backup
- [ ] Restore backup
- [ ] Delete backup
- [ ] List allocations
- [ ] Add allocation
- [ ] Allocation notes
- [ ] Set primary allocation
- [ ] Remove allocation
- [ ] View startup
- [ ] Change startup variables
- [ ] Change Docker image
- [ ] Rename server/edit description
- [ ] Reinstall
- [ ] Server activity
- [ ] SFTP connection details
- [ ] SFTP password auth
- [ ] SFTP key auth

## Schedules and subusers

- [ ] List/view schedules
- [ ] Create/edit/delete schedules
- [ ] Toggle schedule
- [ ] Manual run
- [ ] Only run online
- [ ] Task create/edit/delete
- [ ] Task order and offsets
- [ ] Skip remaining tasks or continue on failure
- [ ] Command task
- [ ] Power task
- [ ] Backup task
- [ ] List/view subusers
- [ ] Invite subuser
- [ ] Edit grants
- [ ] Remove subuser
- [ ] Revoke live capabilities

## Admin

- [ ] Overview
- [ ] List/search servers
- [ ] Provision server
- [ ] Server details/ownership
- [ ] Server build/limits
- [ ] Startup configuration
- [ ] Server database management
- [ ] Attach/detach server mounts
- [ ] Manage install state
- [ ] Suspend/unsuspend
- [ ] Reinstall
- [ ] Transfer/cancel/recover
- [ ] Delete/force delete server
- [ ] List/search users
- [ ] Create/edit/delete user
- [ ] List/create/edit/delete nodes
- [ ] Node health and resource information
- [ ] Node config and deployment token
- [ ] Node server list
- [ ] Node maintenance settings
- [ ] Create allocations
- [ ] Bulk allocation removal
- [ ] Allocation alias
- [ ] List/create/edit/delete locations
- [ ] Manage and test database hosts
- [ ] Mount create/edit
- [ ] Assign mounts to eggs/nodes
- [ ] Nest create/edit/delete
- [ ] Egg create/edit/delete
- [ ] Egg import/update/export
- [ ] Edit egg variables
- [ ] Edit egg install and inheritance
- [ ] Settings and branding
- [ ] SMTP settings and test message
- [ ] Advanced settings
- [ ] Application API key create/revoke and ACL

## System and acceptance

- [ ] 403 page
- [ ] 404 page
- [ ] 500 page
- [ ] 503 page
- [ ] Maintenance page
- [ ] Password reset email
- [ ] New account email
- [ ] Subuser notification email
- [ ] Logo/wordmark
- [ ] Favicon
- [ ] Client API route inventory acceptance
- [ ] Application API route inventory acceptance
- [ ] Real Wings contract qualification
- [ ] Migration rehearsal
- [ ] Minecraft profile
- [ ] Bot profile
- [ ] Web profile
- [ ] Generic fallback
- [ ] English/Indonesian coverage
- [ ] Responsive and accessibility acceptance
