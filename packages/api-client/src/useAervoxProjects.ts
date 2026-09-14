/**
 * Aervox｜思隅 @aervox/api-client — 项目管理与导入 Composable (CR-048 / W3)
 *
 * 提供项目列表拉取、新建、编辑、归档、删除及外部会话安全导入能力。
 */
import { ref, type Ref } from 'vue';
import type {
  CreateProjectRequest,
  ImportSessionRequest,
  ImportSessionResponse,
  ListProjectsResponse,
  ProjectItem,
  UpdateProjectRequest,
} from '@aervox/contracts';
import { getTransport } from './transport';

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
  const projects = ref<ProjectItem[]>([]);
  const selectedProjectId = ref<string | null>(null);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  const fetchProjects = async (includeArchived = false): Promise<ProjectItem[]> => {
    loading.value = true;
    error.value = null;
    try {
      const path = includeArchived ? '/v1/projects?includeArchived=true' : '/v1/projects';
      const res = await getTransport().request<ListProjectsResponse>('GET', path);
      projects.value = res.items ?? [];
      return projects.value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      return projects.value;
    } finally {
      loading.value = false;
    }
  };

  const createProject = async (data: CreateProjectRequest): Promise<ProjectItem | null> => {
    loading.value = true;
    error.value = null;
    try {
      const created = await getTransport().request<ProjectItem>('POST', '/v1/projects', data);
      projects.value = [created, ...projects.value.filter((p) => p.id !== created.id)];
      return created;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      return null;
    } finally {
      loading.value = false;
    }
  };

  const updateProject = async (id: string, data: UpdateProjectRequest): Promise<ProjectItem | null> => {
    if (!id) return null;
    loading.value = true;
    error.value = null;
    try {
      const updated = await getTransport().request<ProjectItem>(
        'PATCH',
        `/v1/projects/${encodeURIComponent(id)}`,
        data,
      );
      const index = projects.value.findIndex((p) => p.id === id);
      if (index !== -1) {
        projects.value[index] = updated;
      }
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      return null;
    } finally {
      loading.value = false;
    }
  };

  const deleteProject = async (id: string): Promise<boolean> => {
    if (!id) return false;
    loading.value = true;
    error.value = null;
    try {
      await getTransport().request<void>('DELETE', `/v1/projects/${encodeURIComponent(id)}`);
      projects.value = projects.value.filter((p) => p.id !== id);
      if (selectedProjectId.value === id) {
        selectedProjectId.value = null;
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      return false;
    } finally {
      loading.value = false;
    }
  };

  const importSession = async (data: ImportSessionRequest): Promise<ImportSessionResponse | null> => {
    loading.value = true;
    error.value = null;
    try {
      const result = await getTransport().request<ImportSessionResponse>(
        'POST',
        '/v1/sessions/import',
        data,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      return null;
    } finally {
      loading.value = false;
    }
  };

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
