import {ipcRenderer} from 'electron'

/** 系统「选择文件夹」对话框（CR-011 阶段 3：本地语音模型路径 / 音色目录） */
export const dialogApi = {
    pickDirectory: async (): Promise<string | null> =>
        ipcRenderer.invoke('dialog:pick-directory') as Promise<string | null>,
}