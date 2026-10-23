# Workspace account creation

## Access

No module exposes account creation by default. Developers can wire the reusable control into a module that needs it:

```tsx
<WorkspaceAccountCreation onCreated={refreshCurrentPage} />
```

The control is available to administrators of active Cloud and Hybrid workspaces. The Edge Function independently checks the caller's role and workspace mode before creating an account. Local workspaces and non-administrators cannot use this flow.

## Account and workspace behavior

- The Edge Function verifies the caller's Supabase session, then reads the caller's role and `current_workspace` from `profiles`.
- Only profile role `admin` can create or enable account creation. The active workspace must be undeleted and in Cloud or Hybrid mode.
- The request accepts a module key and identity credentials. Workspace IDs and roles from the client are ignored.
- Supabase Auth enforces its existing global email identity uniqueness. Emails are trimmed and lowercased before creation.
- Created accounts are email-confirmed so the supplied email and password can sign in immediately through Atlas's existing sign-in flow.
- Each account receives a profile in the admin's current workspace with role `staff`. It does not receive admin permissions or workspace permission rows automatically.
- The existing workspace member limit is checked before creation and enforced again by the profile insert trigger.
- The hosting module refreshes its relevant view through the `onCreated` callback.

## Deployment

Deploy the `workspace-account-creation` Edge Function. No schema migration is required; the flow uses the existing profiles, workspaces, and member-limit infrastructure. Existing login and registration paths are unchanged.
