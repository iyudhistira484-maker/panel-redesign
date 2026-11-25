export const serverPermissions = [
  "websocket.connect",
  "control.console",
  "control.start",
  "control.stop",
  "control.restart",
  "database.read",
  "database.create",
  "database.update",
  "database.delete",
  "database.view_password",
  "schedule.read",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "user.read",
  "user.create",
  "user.update",
  "user.delete",
  "backup.read",
  "backup.create",
  "backup.delete",
  "backup.download",
  "backup.restore",
  "allocation.read",
  "allocation.create",
  "allocation.update",
  "allocation.delete",
  "file.read",
  "file.read-content",
  "file.create",
  "file.update",
  "file.delete",
  "file.archive",
  "file.sftp",
  "startup.read",
  "startup.update",
  "startup.docker-image",
  "settings.rename",
  "settings.reinstall",
  "activity.read",
] as const;
export type ServerPermission = (typeof serverPermissions)[number];
export type Actor = {
  id: string;
  admin: boolean;
  channel: "session" | "api-key";
  keyId?: string;
};
export function canAccount(actor: Actor | null, owner: string, write = false) {
  return actor?.id === owner && (!write || actor.channel === "session");
}
export function canServer(
  actor: Actor | null,
  resource: { id: string; owner: string },
  grant: {
    user: string;
    server: string;
    permissions: readonly string[];
  } | null,
  permission: string,
) {
  if (
    !actor ||
    actor.channel !== "session" ||
    !serverPermissions.some((key) => key === permission)
  )
    return false;
  return (
    actor.admin ||
    actor.id === resource.owner ||
    !!(
      grant?.user === actor.id &&
      grant.server === resource.id &&
      grant.permissions.includes(permission)
    )
  );
}

export function canManageCatalog(actor: Actor | null): actor is Actor {
  return actor?.channel === "session" && actor.admin;
}
