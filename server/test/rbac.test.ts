import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { Client, createUser, freshDb, loggedIn, makeApp } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;
let owner: Client, admin: Client, editor: Client, viewer: Client;
let ownerId: string;

beforeAll(async () => {
  pool = await freshDb();
  app = await makeApp(pool);
  ownerId = await createUser(pool, 'owner@example.com', 'owner');
  owner = await new Client(app).login('owner@example.com');
  admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
  editor = await loggedIn(app, pool, 'editor@example.com', 'editor');
  viewer = await loggedIn(app, pool, 'viewer@example.com', 'viewer');
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('role permissions', () => {
  it('viewer can read but cannot mutate', async () => {
    expect((await viewer.get('/api/admin/dashboard')).statusCode).toBe(200);
    expect((await viewer.get('/api/admin/companies')).statusCode).toBe(200);
    expect((await viewer.post('/api/admin/companies', { name: 'Nope' })).statusCode).toBe(403);
    expect((await viewer.post('/api/admin/jobs/monitor_sources/run')).statusCode).toBe(403);
    expect((await viewer.patch('/api/admin/settings', { key: 'retry', value: {} })).statusCode).toBe(403);
    expect((await viewer.get('/api/admin/users')).statusCode).toBe(403);
    expect((await pool.query('SELECT count(*)::int AS n FROM companies')).rows[0].n).toBe(0);
  });

  it('editor manages content but not users, settings or categories', async () => {
    const r = await editor.post('/api/admin/companies', { name: 'Editor Co', kind: 'vendor' });
    expect(r.statusCode).toBe(201);
    expect((await editor.get('/api/admin/users')).statusCode).toBe(403);
    expect((await editor.post('/api/admin/users', { email: 'n@example.com', name: 'N', role: 'viewer' })).statusCode).toBe(403);
    expect((await editor.patch('/api/admin/settings', { key: 'business', value: { app_name: 'X', support_email: null } })).statusCode).toBe(403);
    expect((await editor.post('/api/admin/categories', { name: 'Telecom' })).statusCode).toBe(403);
    expect((await editor.patch('/api/admin/jobs/monitor_sources', { enabled: false })).statusCode).toBe(403);
  });

  it('admin manages non-owner users but cannot alter an owner or grant owner', async () => {
    expect((await admin.patch(`/api/admin/users/${ownerId}`, { role: 'viewer' })).statusCode).toBe(403);
    expect((await admin.patch(`/api/admin/users/${ownerId}`, { status: 'disabled' })).statusCode).toBe(403);
    expect((await admin.post(`/api/admin/users/${ownerId}/reset-link`)).statusCode).toBe(403);
    expect((await admin.post(`/api/admin/users/${ownerId}/revoke-sessions`)).statusCode).toBe(403);
    expect((await admin.post('/api/admin/users', { email: 'o2@example.com', name: 'O2', role: 'owner' })).statusCode).toBe(403);
    expect((await owner.get('/api/auth/me')).statusCode).toBe(200);

    const created = await admin.post('/api/admin/users', { email: 'New@Example.com', name: 'New', role: 'editor' });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.user).toMatchObject({ email: 'new@example.com', role: 'editor', hasPassword: false });
    expect(body.setupLink).toMatch(/^http:\/\/localhost:80\/admin\/reset-password\?token=.+&setup=1$/);
    expect(body.emailed).toBe(false);
    // No password chosen by the admin: login is impossible until the link is used.
    const pre = await new Client(app).post('/api/auth/login', { email: 'new@example.com', password: 'anything at all' });
    expect(pre.statusCode).toBe(401);
    const token = new URL(body.setupLink).searchParams.get('token')!;
    const set = await new Client(app).post('/api/auth/reset', { token, password: 'brand new password 1' });
    expect(set.statusCode).toBe(200);
    // One-time: reuse fails.
    expect((await new Client(app).post('/api/auth/reset', { token, password: 'brand new password 2' })).statusCode).toBe(400);
    const newbie = await new Client(app).login('new@example.com', 'brand new password 1');
    expect((await newbie.get('/api/auth/me')).json().role).toBe('editor');
    // In-app alert (no SMTP), without the token.
    const alert = await pool.query(`SELECT * FROM alerts WHERE title LIKE 'Setup link issued for new@example.com%'`);
    expect(alert.rowCount).toBe(1);
    expect(alert.rows[0].body).not.toContain(token);

    // Admin disables the editor: their sessions are revoked.
    const id = body.user.id;
    expect((await admin.patch(`/api/admin/users/${id}`, { status: 'disabled' })).statusCode).toBe(200);
    expect((await newbie.get('/api/auth/me')).statusCode).toBe(401);
    // Cannot change own role.
    const me = (await admin.get('/api/auth/me')).json();
    expect((await admin.patch(`/api/admin/users/${me.id}`, { role: 'viewer' })).statusCode).toBe(400);
  });

  it('owner can manage owners but the last owner cannot be removed', async () => {
    const r = await owner.post('/api/admin/users', { email: 'o2@example.com', name: 'O2', role: 'owner' });
    expect(r.statusCode).toBe(201);
    const o2 = r.json().user.id;
    expect((await owner.patch(`/api/admin/users/${o2}`, { role: 'admin' })).statusCode).toBe(200);
    // ownerId is the only owner left; o2 (now admin) cannot demote it and owner cannot demote self.
    expect((await owner.patch(`/api/admin/users/${ownerId}`, { role: 'admin' })).statusCode).toBe(400);
  });

  it('writes audit entries with before/after for mutations', async () => {
    const created = await editor.post('/api/admin/companies', { name: 'Audited Co' });
    const id = created.json().id;
    await editor.patch(`/api/admin/companies/${id}`, { description: 'Updated' });
    const rows = (
      await pool.query(`SELECT action, before, after, actor_user_id, ip FROM audit_log WHERE entity_id = $1 ORDER BY id`, [id])
    ).rows;
    expect(rows.map((r) => r.action)).toEqual(['company.create', 'company.update']);
    expect(rows[0].before).toBeNull();
    expect(rows[0].after.name).toBe('Audited Co');
    expect(rows[1].before.description).toBeNull();
    expect(rows[1].after.description).toBe('Updated');
    expect(rows[1].actor_user_id).toBeTruthy();
    const userAudit = await pool.query(`SELECT after FROM audit_log WHERE action = 'user.create'`);
    for (const r of userAudit.rows) expect(JSON.stringify(r.after)).not.toContain('scrypt$');
    const list = await admin.get('/api/admin/audit?entityType=company');
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThanOrEqual(2);
    expect((await editor.get('/api/admin/audit')).statusCode).toBe(403);
  });
});
