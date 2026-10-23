import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  BranchTreeLimitError,
  BRANCH_TREE_MAX_BRANCHES,
  BRANCH_TREE_MAX_SESSIONS,
  createInMemoryDatabase,
  type AervoxDatabase,
  type ConversationBranchModel,
} from '../src/index.js'
import {SessionStore} from '../src/repositories/sqlite/conversation/session-store.js'

const ctx = {workspaceId: 'local', subjectUserId: 'local'}
const edge = (id: string, parentSessionId: string, childSessionId: string): ConversationBranchModel => ({
  id, parentSessionId, childSessionId, status: 'active', createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
})

describe('bounded conversation branch graph reads', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>
  let store: SessionStore
  beforeEach(async () => {
    database = await createInMemoryDatabase()
    store = new SessionStore(database.db)
  })
  afterEach(async () => {vi.restoreAllMocks(); await database.cleanup()})

  async function graph(edges: Array<[string, string, string]>) {
    for (const id of new Set(edges.flatMap(([, parent, child]) => [parent, child]))) {
      await store.createSession(ctx, id, {id})
    }
    for (const [id, parentSessionId, childSessionId] of edges) {
      await store.createExplorationBranch(ctx, {id, parentSessionId, childSessionId})
    }
  }

  it('terminates a durable A to B to A cycle, querying each session once', async () => {
    await graph([['ab', 'A', 'B'], ['ba', 'B', 'A']])
    const queries = vi.spyOn(store, 'listBranchesByParent')
    const tree = await store.getBranchTree(ctx, 'A')
    expect(tree.map(item => item.id)).toEqual(['ab', 'ba'])
    expect(queries.mock.calls.map(([, id]) => id)).toEqual(['A', 'B'])
  })

  it('retains separate edges in a DAG while traversing a shared child only once in sibling-first DFS order', async () => {
    await graph([
      ['root_a', 'root', 'A'], ['root_b', 'root', 'B'],
      ['a_shared', 'A', 'shared'], ['a_shared_again', 'A', 'shared'],
      ['b_shared', 'B', 'shared'], ['b_leaf', 'B', 'B-leaf'], ['shared_leaf', 'shared', 'leaf'],
    ])
    const queries = vi.spyOn(store, 'listBranchesByParent')
    const tree = await store.getBranchTree(ctx, 'root')
    expect(tree.map(item => item.id)).toEqual(['root_a', 'root_b', 'a_shared', 'a_shared_again', 'shared_leaf', 'b_shared', 'b_leaf'])
    expect(queries.mock.calls.map(([, id]) => id)).toEqual(['root', 'A', 'shared', 'leaf', 'B', 'B-leaf'])
    expect(queries.mock.calls.filter(([, id]) => id === 'shared')).toHaveLength(1)
  })

  it('returns an empty missing root and excludes soft-deleted edges without deleting child data', async () => {
    expect(await store.getBranchTree(ctx, 'missing')).toEqual([])
    await graph([['root_a', 'root', 'A'], ['a_child', 'A', 'child'], ['root_b', 'root', 'B']])
    const deleted = await store.deleteBranch(ctx, 'root_a')
    expect(deleted).toMatchObject({id: 'root_a', status: 'deleted', deletedAt: expect.any(String)})
    expect((await store.getBranchTree(ctx, 'root')).map(item => item.id)).toEqual(['root_b'])
    expect(await store.getSession(ctx, 'A')).toMatchObject({id: 'A'})
    expect((await store.getBranchTree(ctx, 'A')).map(item => item.id)).toEqual(['a_child'])
    const raw = await database.client.execute({sql: 'SELECT status, deleted_at FROM conversation_branches WHERE id = ?', args: ['root_a']})
    expect(raw.rows).toHaveLength(1)
    expect(raw.rows[0]).toMatchObject({status: 'deleted', deleted_at: expect.any(String)})
  })

  it('deduplicates repeated branch IDs returned by a query before spending the edge budget', async () => {
    const ab = edge('ab', 'A', 'B')
    const queries = vi.spyOn(store, 'listBranchesByParent').mockImplementation(async (_ctx, id) => id === 'A' ? [ab, ab, {...ab}] : [])
    expect(await store.getBranchTree(ctx, 'A')).toEqual([ab])
    expect(queries.mock.calls.map(([, id]) => id)).toEqual(['A', 'B'])
  })

  it('supports the exact session budget without recursive stack growth, and rejects one more session without a partial result', async () => {
    expect(BRANCH_TREE_MAX_SESSIONS).toBe(1000)
    let beyondBudget = false
    const queries = vi.spyOn(store, 'listBranchesByParent').mockImplementation(async (_ctx, id) => {
      const index = Number(id.slice(1))
      return index < BRANCH_TREE_MAX_SESSIONS - 1 || (beyondBudget && index === BRANCH_TREE_MAX_SESSIONS - 1)
        ? [edge(`branch_${index}`, id, `s${index + 1}`)] : []
    })
    const exact = await store.getBranchTree(ctx, 's0')
    expect(exact).toHaveLength(BRANCH_TREE_MAX_SESSIONS - 1)
    expect(queries).toHaveBeenCalledTimes(BRANCH_TREE_MAX_SESSIONS)
    expect(queries.mock.calls.every(([, , options]) => options?.limit !== undefined && options.limit <= BRANCH_TREE_MAX_BRANCHES + 1)).toBe(true)
    queries.mockClear()
    beyondBudget = true
    await expect(store.getBranchTree(ctx, 's0')).rejects.toBeInstanceOf(BranchTreeLimitError)
    expect(queries).toHaveBeenCalledTimes(BRANCH_TREE_MAX_SESSIONS)
    expect(queries.mock.calls.some(([, id]) => id === `s${BRANCH_TREE_MAX_SESSIONS}`)).toBe(false)
  })

  it('accepts exactly 10000 unique edges to one shared child and requests only remaining plus one rows', async () => {
    expect(BRANCH_TREE_MAX_BRANCHES).toBe(10000)
    const wide = Array.from({length: BRANCH_TREE_MAX_BRANCHES}, (_, i) => edge(`wide_${i}`, 'root', 'shared'))
    const queries = vi.spyOn(store, 'listBranchesByParent').mockImplementation(async (_ctx, id, options) => id === 'root' ? wide.slice(0, options?.limit) : [])
    const tree = await store.getBranchTree(ctx, 'root')
    expect(tree).toHaveLength(BRANCH_TREE_MAX_BRANCHES)
    expect(queries.mock.calls.map(([, id, options]) => [id, options?.limit])).toEqual([
      ['root', BRANCH_TREE_MAX_BRANCHES + 1], ['shared', 1],
    ])
  })

  it('rejects a wide over-budget query immediately instead of returning a truncated graph', async () => {
    const wide = Array.from({length: BRANCH_TREE_MAX_BRANCHES + 1}, (_, i) => edge(`wide_${i}`, 'root', 'shared'))
    const queries = vi.spyOn(store, 'listBranchesByParent').mockImplementation(async (_ctx, _id, options) => wide.slice(0, options?.limit))
    await expect(store.getBranchTree(ctx, 'root')).rejects.toMatchObject({name: 'BranchTreeLimitError', message: 'branch_tree_limit_exceeded'})
    expect(queries).toHaveBeenCalledTimes(1)
    expect(queries.mock.calls[0][2]).toEqual({limit: BRANCH_TREE_MAX_BRANCHES + 1})
  })

  it('decreases SQL row allowance after previous siblings rather than letting each node allocate the whole budget', async () => {
    const rootEdges = [edge('root_a', 'root', 'A'), edge('root_b', 'root', 'B')]
    const queries = vi.spyOn(store, 'listBranchesByParent').mockImplementation(async (_ctx, id) => id === 'root' ? rootEdges : id === 'A' ? [edge('a_leaf', 'A', 'leaf')] : [])
    await store.getBranchTree(ctx, 'root')
    expect(queries.mock.calls.map(([, id, options]) => [id, options?.limit])).toEqual([
      ['root', 10001], ['A', 9999], ['leaf', 9998], ['B', 9998],
    ])
  })

  it('applies the requested bound to the actual SQL query', async () => {
    const rows = [edge('a', 'root', 'child')]
    const limit = vi.fn(async (_count: number) => rows)
    const query = {from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit}
    const sqlStore = new SessionStore({select: vi.fn(() => query)} as unknown as AervoxDatabase)
    expect(await sqlStore.listBranchesByParent(ctx, 'root', {limit: 3})).toEqual(rows)
    expect(limit).toHaveBeenCalledWith(3)
  })

  it('rejects an already aborted read before querying any session', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled before traversal')
    controller.abort(reason)
    const queries = vi.spyOn(store, 'listBranchesByParent')
    await expect(store.getBranchTree(ctx, 'root', {signal: controller.signal})).rejects.toBe(reason)
    expect(queries).not.toHaveBeenCalled()
  })

  it('checks abort again after an awaited query and publishes no partial result or child query', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled during query')
    let resolve!: (rows: ConversationBranchModel[]) => void
    const queries = vi.spyOn(store, 'listBranchesByParent').mockImplementation(() => new Promise(done => {resolve = done}))
    const pending = store.getBranchTree(ctx, 'root', {signal: controller.signal})
    controller.abort(reason)
    resolve([edge('root_child', 'root', 'child')])
    await expect(pending).rejects.toBe(reason)
    expect(queries).toHaveBeenCalledTimes(1)
  })
})
