import { useState, type FormEvent } from 'react';
import { api, asList } from '../lib/api';
import { useApi, useAction } from '../lib/useApi';
import { useCan } from '../lib/auth';
import type { Category } from '../lib/types';
import { formatIST } from '../lib/format';
import { Field, LiveStatus, Loadable, PageHeader, TableWrap } from '../components/ui';

export function CategoriesPage() {
  const list = useApi<unknown>('/admin/categories?limit=500');
  const cats = asList<Category>(list.data, 'categories');
  const canAdmin = useCan('admin');
  const action = useAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return action.setStatus({ kind: 'error', text: 'Name is required.' });
    const ok = await action.run(() => api.post('/admin/categories', { name: name.trim(), description: description.trim() || null }), 'Category added.');
    if (ok !== undefined) {
      setName('');
      setDescription('');
      list.reload();
    }
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editId) return;
    const ok = await action.run(() => api.patch(`/admin/categories/${editId}`, { name: editName.trim(), description: editDesc.trim() || null }), 'Category updated.');
    if (ok !== undefined) {
      setEditId(null);
      list.reload();
    }
  }

  async function remove(c: Category) {
    if (!window.confirm(`Delete category "${c.name}"?`)) return;
    await action.run(() => api.del(`/admin/categories/${c.id}`), 'Category deleted.');
    list.reload();
  }

  return (
    <>
      <PageHeader title="Categories">{canAdmin ? null : 'Read-only. Admins manage categories.'}</PageHeader>
      {canAdmin ? (
        <form className="card filters" onSubmit={create} aria-label="Add category">
          <Field label="Name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
          <Field label="Description">{(id) => <input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <button className="btn btn-primary" type="submit" disabled={action.busy}>
            Add category
          </button>
        </form>
      ) : null}
      <LiveStatus status={action.status} />
      <Loadable loading={list.loading} error={list.error} empty={cats.length === 0} emptyText="No categories yet — add the first one">
        <TableWrap label="Categories">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Description</th>
              <th scope="col">Created</th>
              {canAdmin ? <th scope="col">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {cats.map((c) =>
              editId === c.id ? (
                <tr key={c.id}>
                  <td colSpan={canAdmin ? 4 : 3}>
                    <form className="filters" onSubmit={saveEdit} aria-label={`Edit ${c.name}`}>
                      <Field label="Name">{(id) => <input id={id} value={editName} onChange={(e) => setEditName(e.target.value)} />}</Field>
                      <Field label="Description">{(id) => <input id={id} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />}</Field>
                      <button className="btn btn-primary" type="submit">
                        Save
                      </button>
                      <button className="btn" type="button" onClick={() => setEditId(null)}>
                        Cancel
                      </button>
                    </form>
                  </td>
                </tr>
              ) : (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.description || '—'}</td>
                  <td>{formatIST(c.createdAt, '—')}</td>
                  {canAdmin ? (
                    <td className="row-actions">
                      <button
                        className="btn btn-small"
                        type="button"
                        onClick={() => {
                          setEditId(c.id);
                          setEditName(c.name);
                          setEditDesc(c.description ?? '');
                        }}
                      >
                        Edit
                      </button>
                      <button className="btn btn-small btn-danger" type="button" onClick={() => remove(c)}>
                        Delete
                      </button>
                    </td>
                  ) : null}
                </tr>
              ),
            )}
          </tbody>
        </TableWrap>
      </Loadable>
    </>
  );
}
