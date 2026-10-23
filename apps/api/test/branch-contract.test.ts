import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {apiEndpointPath, apiProblemSchema, branchesApi} from '@aervox/contracts'
import {BranchTreeLimitError, createInMemoryDatabase, SqliteConversationRepository} from '@aervox/repositories'
import {buildApp} from './app-fixture.js'

const ctx = {workspaceId: 'local', subjectUserId: 'local'}
const token = 'branch-contract-fixture-token'
const endpointRequests = [
  ['POST', '/v1/sessions/root/branches'],
  ['GET', '/v1/sessions/root/branches'],
  ['GET', '/v1/sessions/root/branch-tree'],
  ['GET', '/v1/branches/branch-fixture'],
  ['POST', '/v1/branches/branch-fixture/merge'],
  ['POST', '/v1/branches/branch-fixture/archive'],
  ['PATCH', '/v1/branches/branch-fixture/layout'],
  ['DELETE', '/v1/branches/branch-fixture'],
] as const

describe('branch shared contracts over real HTTP', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>
  let built: Awaited<ReturnType<typeof buildApp>>
  let repo: SqliteConversationRepository
  let base: string

  async function request(method: string, path: string, body?: unknown, auth: string | null = `Bearer ${token}`, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {...(auth ? {authorization: auth} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'}), ...extraHeaders},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    })
    return {status: response.status, body: await response.json(), contentType: response.headers.get('content-type')}
  }

  async function create(childSessionId: string, body: Record<string, unknown> = {}) {
    const response = await request('POST', '/v1/sessions/root/branches', {childSessionId, ...body})
    expect(response.status).toBe(201)
    return branchesApi.create.response.parse(response.body)
  }

  beforeEach(async () => {
    database = await createInMemoryDatabase()
    repo = new SqliteConversationRepository(database.db)
    await repo.createSession(ctx, 'Parent title', {id: 'root'})
    built = await buildApp({db: database.db, client: database.client, auth: {mode: 'token', token}})
    base = await built.app.listen({host: '127.0.0.1', port: 0})
  })
  afterEach(async () => {vi.restoreAllMocks(); await built.app.close(); await database.cleanup()})

  it('authenticates all eight endpoint shapes before validating bodies or reaching persistence', async () => {
    const mutations = vi.spyOn(SqliteConversationRepository.prototype, 'createExplorationBranch')
    for (const [method, path] of endpointRequests) {
      for (const auth of [null, 'Bearer wrong-token']) {
        const response = await request(method, path, undefined, auth)
        expect(response.status).toBe(401)
        expect(apiProblemSchema.parse(response.body)).toMatchObject({status: 401, code: 'AUTH_UNAUTHORIZED'})
      }
    }
    expect(mutations).not.toHaveBeenCalled()
    expect((await database.client.execute('SELECT id FROM conversation_branches')).rows).toEqual([])
  })

  it('rejects absent/invalid create inputs without creating an orphan child', async () => {
    const mutations = vi.spyOn(SqliteConversationRepository.prototype, 'createExplorationBranch')
    for (const body of [undefined, null, {}, {childSessionId: ''}, {childSessionId: 42}, {childSessionId: 'child', branchReason: 'unsafe'}, {childSessionId: 'child', title: []}]) {
      const response = await request('POST', '/v1/sessions/root/branches', body)
      expect(response.status).toBe(400)
      expect(apiProblemSchema.parse(response.body)).toMatchObject({status: 400, error: 'Validation failed'})
    }
    const self = await request('POST', '/v1/sessions/root/branches', {childSessionId: 'root'})
    expect(self.status).toBe(400)
    expect(apiProblemSchema.parse(self.body).error).toBe('branch_requires_distinct_sessions')
    expect(mutations).not.toHaveBeenCalled()
    expect(await repo.getSession(ctx, 'child')).toBeNull()
  })

  it('requires layoutData while preserving every JSON value including null and primitive values', async () => {
    const branch = await create('layout-child')
    const path = apiEndpointPath(branchesApi.updateLayout, {branchId: branch.id})
    for (const body of [undefined, null, {}, {other: 'missing'}]) {
      const invalid = await request('PATCH', path, body)
      expect(invalid.status).toBe(400)
      expect(apiProblemSchema.parse(invalid.body).error).toBe('Validation failed')
    }
    for (const layoutData of [null, false, 0, 'position', ['x', 2, null], {x: 10, nested: {visible: false}}]) {
      const updated = await request('PATCH', path, {layoutData})
      expect(updated.status).toBe(200)
      expect(branchesApi.updateLayout.response.parse(updated.body).layoutData).toEqual(layoutData)
      const read = await request('GET', apiEndpointPath(branchesApi.get, {branchId: branch.id}))
      expect(branchesApi.get.response.parse(read.body).layoutData).toEqual(layoutData)
    }
  })

  it('replays one durable branch across concurrent same-key requests and rejects changed intent', async () => {
    const payload = {childSessionId: 'idempotent-child', title: 'Stable title', forkAtMessageId: 'opaque-history'}
    const send = (body: unknown) => request('POST', '/v1/sessions/root/branches', body, `Bearer ${token}`, {'idempotency-key': 'branch-request'})
    const [first, second] = await Promise.all([send(payload), send(payload)])
    expect(first.status).toBe(201)
    expect(second).toEqual(first)
    expect((await send({...payload, childSessionId: 'unwanted-child'})).status).toBe(409)
    expect((await send({...payload, title: 'Changed title'})).status).toBe(409)
    expect(await repo.getSession(ctx, 'unwanted-child')).toBeNull()
    expect((await database.client.execute('SELECT id FROM conversation_branches')).rows).toHaveLength(1)
    expect((await database.client.execute("SELECT id FROM outbox_events WHERE event_type='conversation.branch.created'")).rows).toHaveLength(1)
    await repo.deleteBranch(ctx, first.body.id)
    expect((await send(payload)).body).toMatchObject({id: first.body.id, status: 'deleted'})
    expect((await repo.listBranchesByParent(ctx, 'root'))).toEqual([])
    await repo.deleteSession(ctx, payload.childSessionId)
    const afterDelete = await send(payload)
    expect(afterDelete.status).toBe(409)
    expect(apiProblemSchema.parse(afterDelete.body).error).toBe('conversation_branch_result_unavailable')
    expect(await repo.getSession(ctx, payload.childSessionId)).toBeNull()
    expect((await database.client.execute('SELECT id FROM conversation_branches')).rows).toHaveLength(0)
  })

  it('rolls back the child and edge when outbox commit fails, then safely retries the same key', async () => {
    const send = () => request('POST', '/v1/sessions/root/branches', {childSessionId: 'rollback-child'}, `Bearer ${token}`, {'idempotency-key': 'outbox-fault'})
    await database.client.execute("CREATE TRIGGER fail_branch_outbox BEFORE INSERT ON outbox_events WHEN NEW.event_type='conversation.branch.created' BEGIN SELECT RAISE(ABORT, 'injected'); END")
    expect((await send()).status).toBe(500)
    expect(await repo.getSession(ctx, 'rollback-child')).toBeNull()
    expect((await database.client.execute('SELECT id FROM conversation_branches')).rows).toHaveLength(0)
    await database.client.execute('DROP TRIGGER fail_branch_outbox')
    const first = await send()
    expect(first.status).toBe(201)
    expect(await send()).toEqual(first)
  })

  it('rejects invalid operation keys before creating a child', async () => {
    for (const key of ['', 'x'.repeat(513)]) {
      const response = await request('POST', '/v1/sessions/root/branches', {childSessionId: 'invalid-key-child'}, `Bearer ${token}`, {'idempotency-key': key})
      expect(response.status).toBe(400)
    }
    expect(await repo.getSession(ctx, 'invalid-key-child')).toBeNull()
  })

  it('keeps all eight success statuses, fields and lifecycle transitions through the shared response schemas', async () => {
    const merged = await create('merge-child', {title: 'Fork title', branchReason: 'text_followup', forkAtMessageId: 'message-fixture'})
    expect(merged).toMatchObject({parentSessionId: 'root', childSessionId: 'merge-child', title: 'Fork title', branchReason: 'text_followup', forkAtMessageId: 'message-fixture', status: 'active'})
    expect(await repo.getSession(ctx, 'merge-child')).toMatchObject({title: 'Fork title', executionPolicy: 'local-v1'})
    const archived = await create('archive-child')
    expect(await repo.getSession(ctx, 'archive-child')).toMatchObject({title: 'Parent title', executionPolicy: 'local-v1'})
    const deleted = await create('delete-child')
    const list = await request('GET', apiEndpointPath(branchesApi.list, {sessionId: 'root'}))
    expect(list.status).toBe(200)
    expect(branchesApi.list.response.parse(list.body).items.map(item => item.id)).toEqual([merged.id, archived.id, deleted.id])
    const tree = await request('GET', apiEndpointPath(branchesApi.tree, {sessionId: 'root'}))
    expect(tree.status).toBe(200)
    expect(branchesApi.tree.response.parse(tree.body)).toEqual(branchesApi.list.response.parse(list.body))
    const read = await request('GET', apiEndpointPath(branchesApi.get, {branchId: merged.id}))
    expect(read.status).toBe(200)
    expect(branchesApi.get.response.parse(read.body)).toEqual(merged)
    const merge = await request('POST', apiEndpointPath(branchesApi.merge, {branchId: merged.id}))
    expect(merge.status).toBe(200)
    expect(branchesApi.merge.response.parse(merge.body)).toMatchObject({id: merged.id, status: 'merged', mergedAt: expect.any(String)})
    const archive = await request('POST', apiEndpointPath(branchesApi.archive, {branchId: archived.id}))
    expect(archive.status).toBe(200)
    expect(branchesApi.archive.response.parse(archive.body)).toMatchObject({id: archived.id, status: 'archived'})
    const layout = await request('PATCH', apiEndpointPath(branchesApi.updateLayout, {branchId: archived.id}), {layoutData: {x: 10}})
    expect(layout.status).toBe(200)
    expect(branchesApi.updateLayout.response.parse(layout.body)).toMatchObject({status: 'archived', layoutData: {x: 10}})
    const remove = await request('DELETE', apiEndpointPath(branchesApi.delete, {branchId: deleted.id}))
    expect(remove.status).toBe(200)
    expect(branchesApi.delete.response.parse(remove.body)).toMatchObject({id: deleted.id, status: 'deleted', deletedAt: expect.any(String)})
    expect((await request('GET', apiEndpointPath(branchesApi.get, {branchId: deleted.id}))).status).toBe(404)
    expect((await request('DELETE', apiEndpointPath(branchesApi.delete, {branchId: deleted.id}))).status).toBe(404)
    const raw = await database.client.execute({sql: 'SELECT status, deleted_at FROM conversation_branches WHERE id = ?', args: [deleted.id]})
    expect(raw.rows).toHaveLength(1)
    expect(raw.rows[0]).toMatchObject({status: 'deleted', deleted_at: expect.any(String)})
    expect(await repo.getSession(ctx, 'delete-child')).toMatchObject({id: 'delete-child'})
    const after = branchesApi.tree.response.parse((await request('GET', '/v1/sessions/root/branch-tree')).body)
    expect(after.items.map(item => item.id)).toEqual([merged.id, archived.id])
  })

  it('preserves missing root items and legacy not-found/lifecycle error fields', async () => {
    for (const endpoint of [branchesApi.list, branchesApi.tree]) {
      const response = await request('GET', apiEndpointPath(endpoint, {sessionId: 'missing'}))
      expect(response.status).toBe(200)
      expect(endpoint.response.parse(response.body)).toEqual({items: []})
    }
    const missingParent = await request('POST', '/v1/sessions/missing/branches', {childSessionId: 'orphan'})
    expect(missingParent.status).toBe(404)
    expect(apiProblemSchema.parse(missingParent.body).error).toBe('Parent session not found')
    expect(await repo.getSession(ctx, 'orphan')).toBeNull()
    for (const endpoint of [branchesApi.get, branchesApi.merge, branchesApi.archive, branchesApi.updateLayout, branchesApi.delete]) {
      const response = await request(endpoint.method.toUpperCase(), apiEndpointPath(endpoint, {branchId: 'missing'}), endpoint === branchesApi.updateLayout ? {layoutData: null} : undefined)
      expect(response.status).toBe(404)
      expect(apiProblemSchema.parse(response.body).error).toBe(endpoint === branchesApi.merge || endpoint === branchesApi.archive ? 'Branch not found or not active' : 'Branch not found')
    }
    const branch = await create('lifecycle-child')
    expect((await request('POST', apiEndpointPath(branchesApi.merge, {branchId: branch.id}))).status).toBe(200)
    for (const endpoint of [branchesApi.merge, branchesApi.archive]) {
      const response = await request('POST', apiEndpointPath(endpoint, {branchId: branch.id}))
      expect(response.status).toBe(404)
      expect(apiProblemSchema.parse(response.body).error).toBe('Branch not found or not active')
    }
  })

  it('terminates cycles and retains DAG edges through the actual HTTP tree path', async () => {
    for (const id of ['A', 'B', 'shared', 'leaf']) await repo.createSession(ctx, id, {id})
    for (const [id, parentSessionId, childSessionId] of [
      ['root_a', 'root', 'A'], ['root_b', 'root', 'B'], ['a_root', 'A', 'root'],
      ['a_shared', 'A', 'shared'], ['b_shared', 'B', 'shared'], ['shared_leaf', 'shared', 'leaf'],
    ]) await repo.createExplorationBranch(ctx, {id, parentSessionId, childSessionId})
    const response = await request('GET', '/v1/sessions/root/branch-tree')
    expect(response.status).toBe(200)
    expect(branchesApi.tree.response.parse(response.body).items.map(item => item.id)).toEqual(['root_a', 'root_b', 'a_root', 'a_shared', 'shared_leaf', 'b_shared'])
  })

  it('maps a bounded traversal failure to a fixed 422 problem without publishing a partial tree', async () => {
    vi.spyOn(SqliteConversationRepository.prototype, 'getBranchTree').mockRejectedValue(new BranchTreeLimitError())
    const response = await request('GET', '/v1/sessions/root/branch-tree')
    expect(response.status).toBe(422)
    expect(response.contentType).toContain('application/problem+json')
    expect(apiProblemSchema.parse(response.body)).toMatchObject({status: 422, code: 'branch_tree_limit_exceeded', error: 'branch_tree_limit_exceeded'})
    expect(response.body).not.toHaveProperty('items')
  })

  it('conceals unexpected repository failures on all eight endpoints', async () => {
    for (const method of ['createExplorationBranch', 'listBranchesByParent', 'getBranchTree', 'getBranch', 'mergeBranch', 'archiveBranch', 'updateBranchLayout', 'deleteBranch'] as const) {
      vi.spyOn(SqliteConversationRepository.prototype, method).mockRejectedValue(new Error('SELECT secret FROM /private/internal.sqlite'))
    }
    for (const [method, path] of endpointRequests) {
      const response = await request(method, path, method === 'POST' && path.endsWith('/branches') ? {childSessionId: 'child'} : method === 'PATCH' ? {layoutData: null} : undefined)
      expect(response.status).toBe(500)
      expect(response.contentType).toContain('application/problem+json')
      expect(apiProblemSchema.parse(response.body)).toMatchObject({status: 500, code: 'INTERNAL_ERROR', message: 'Internal Server Error'})
      expect(JSON.stringify(response.body)).not.toMatch(/SELECT|secret|private|internal\.sqlite/)
    }
  })

  it('rejects malformed successful persistence responses without exposing their payload', async () => {
    vi.spyOn(SqliteConversationRepository.prototype, 'getBranch').mockResolvedValue({privateState: 'never-publish-secret'} as never)
    vi.spyOn(SqliteConversationRepository.prototype, 'getBranchTree').mockResolvedValue([{id: 'malformed', privateState: 'never-publish-secret'}] as never)
    for (const path of ['/v1/branches/branch-fixture', '/v1/sessions/root/branch-tree']) {
      const response = await request('GET', path)
      expect(response.status).toBe(500)
      expect(apiProblemSchema.parse(response.body).message).toBe('Internal Server Error')
      expect(JSON.stringify(response.body)).not.toMatch(/never-publish|privateState|malformed/)
    }
  })
})
