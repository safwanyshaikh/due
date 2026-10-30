import { createContext, useContext } from 'react';
import type { Me, Role } from './types';

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export type Permission = 'read' | 'edit' | 'admin' | 'owner';

const REQUIRED: Record<Permission, Role> = {
  read: 'viewer',
  edit: 'editor',
  admin: 'admin',
  owner: 'owner',
};

export function can(role: Role | null | undefined, perm: Permission): boolean {
  if (!role || !(role in RANK)) return false;
  return RANK[role] >= RANK[REQUIRED[perm]];
}

export interface AuthState {
  me: Me | null;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  me: null,
  setMe: () => undefined,
  refresh: async () => undefined,
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function useCan(perm: Permission): boolean {
  const { me } = useAuth();
  return can(me?.role, perm);
}

export const ROLES: Role[] = ['viewer', 'editor', 'admin', 'owner'];
