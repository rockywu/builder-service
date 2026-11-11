import type { Command } from '../modules/platform/store.js';
export interface User {
  id: number;
  username: string;
  role: 'admin' | 'user';
}
export interface StoredUser extends User {
  password_hash: string;
  enabled: number;
}
export interface DatabaseOperations {
  platform: { input: Command; result: unknown };
  backup: { input: { filename: string }; result: null };
  findUser: { input: { username: string }; result: StoredUser | null };
  createSession: {
    input: {
      userId: number;
      expectedPasswordHash: string;
      tokenHash: string;
      expiresAt: number;
      previousTokenHash: string | null;
    };
    result: User | null;
  };
  getSession: {
    input: { tokenHash: string; now: number };
    result: User | null;
  };
  deleteSession: { input: { tokenHash: string }; result: null };
}
export type Operation = keyof DatabaseOperations;
export type DatabaseRequest = {
  [K in Operation]: {
    id: number;
    operation: K;
    input: DatabaseOperations[K]['input'];
  };
}[Operation];
export type DatabaseResponse = {
  id: number;
  result?: unknown;
  error?: string;
  statusCode?: number;
};
