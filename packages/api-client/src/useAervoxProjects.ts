import { getClientTransport } from './client-context.js';
/**
 * Aervox｜思隅 @aervox/api-client — 项目管理与导入 Composable (CR-048 / W3)
 *
 * 提供项目列表拉取、新建、编辑、归档、删除及外部会话安全导入能力。
 */
import { computed, ref, type Ref } from 'vue';
import { createResource } from './resource.js';
import {
  createProjectRequestSchema,
  updateProjectRequestSchema,
  projectItemSchema,
  listProjectsResponseSchema,
  importSessionRequestSchema,
  importSessionResponseSchema,
} from '@aervox/contracts';
import type {
  CreateProjectRequest,
  ImportSessionRequest,
  ImportSessionResponse,
  ProjectItem,
  UpdateProjectRequest,
} from '@aervox/contracts';


export interface UseAervoxProjectsReturn {
  projects: Ref<ProjectItem[]>;
  selectedProjectId: Ref<string | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  fetchProjects: (includeArchived?: boolean) => Promise<ProjectItem[]>;
  createProject: (data: CreateProjectRequest) => Promise<ProjectItem | null>;
  updateProject: (id: string, data: UpdateProjectRequest) => Promise<ProjectItem | null>;
  deleteProject: (id: string) => Promise<boolean>;
  importSession: (data: ImportSessionRequest) => Promise<ImportSessionResponse | null>;
  selectProject: (id: string | null) => void;
}

export function useAervoxProjects(): UseAervoxProjectsReturn {
  const transport = getClientTransport();
  const projects = ref<ProjectItem[]>([]);
  const selectedProjectId = ref<string | null>(null);
  const writeError = ref<string | null>(null);
  const pendingWrites = ref(0);
  const resource = createResource(async (includeArchived = false) => {
    const path = includeArchived ? '/v1/projects?includeArchived=true' : '/v1/projects';
    const response = await transport.request('GET', path);
    return listProjectsResponseSchema.parse(response).items;
  }, items => { projects.value = items; });
  const loading = computed(() => resource.loading.value || pendingWrites.value > 0);
  const error = computed(() => writeError.value ?? resource.error.value);
  const write = async <T>(command: () => Promise<T>, fallback: T): Promise<T> => {
    pendingWrites.value++; writeError.value = null;
    try { return await command(); }
    catch (cause) { writeError.value = cause instanceof Error ? cause.message : String(cause); return fallback; }
    finally { pendingWrites.value--; }
  };

  const fetchProjects = async (includeArchived = false): Promise<ProjectItem[]> => {
    writeError.value = null;
    try { await resource.load(includeArchived); }
    catch { /* Failed refresh retains the previous projection and its observable error. */ }
    return projects.value;
  };
  const createProject = (data: CreateProjectRequest): Promise<ProjectItem | null> => write(async () => {
    createProjectRequestSchema.parse(data);
    const created = projectItemSchema.parse(await transport.request('POST', '/v1/projects', data));
    // A confirmed write invalidates every older list query, including archived filters.
    resource.replace([created, ...projects.value.filter(project => project.id !== created.id)]);
    return created;
  }, null);
  const updateProject = async (id: string, data: UpdateProjectRequest): Promise<ProjectItem | null> => {
    if (!id) return null;
    return write(async () => {
      updateProjectRequestSchema.parse(data);
      const updated = projectItemSchema.parse(await transport.request('PATCH', `/v1/projects/${encodeURIComponent(id)}`, data));
      resource.replace(projects.value.map(project => project.id === id ? updated : project));
      return updated;
    }, null);
  };
  const deleteProject = async (id: string): Promise<boolean> => {
    if (!id) return false;
    return write(async () => {
      await transport.request<void>('DELETE', `/v1/projects/${encodeURIComponent(id)}`);
      resource.replace(projects.value.filter(project => project.id !== id));
      if (selectedProjectId.value === id) selectedProjectId.value = null;
      return true;
    }, false);
  };
  const importSession = (data: ImportSessionRequest): Promise<ImportSessionResponse | null> => write(async () => {
    importSessionRequestSchema.parse(data);
    return importSessionResponseSchema.parse(await transport.request('POST', '/v1/sessions/import', data));
  }, null);

  const selectProject = (id: string | null): void => {
    selectedProjectId.value = id;
  };

  return {
    projects,
    selectedProjectId,
    loading,
    error,
    fetchProjects,
    createProject,
    updateProject,
    deleteProject,
    importSession,
    selectProject,
  };
}
