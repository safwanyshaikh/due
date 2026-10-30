export const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

const LEVEL: Record<Role, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function hasRole(actual: Role, required: Role): boolean {
  return LEVEL[actual] >= LEVEL[required];
}

export function roleLevel(r: Role): number {
  return LEVEL[r];
}
