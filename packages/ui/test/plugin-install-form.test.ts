/**
 * @aervox/ui — 插件安装表单纯函数校验测试（CAP-020 扩展中心）
 */
import {describe, expect, it} from 'vitest'
import {validatePluginInstallForm} from '../src/components/plugin/plugin-install-form'

const base = {
  id: 'com.example.notes',
  publisher: 'aervox-official',
  version: '0.1.0',
  rawPermissions: '',
  rawTools: '',
  rawSkills: '',
}

describe('validatePluginInstallForm', () => {
  it('必填项缺失时给出指引信息', () => {
    expect(validatePluginInstallForm({...base, id: '  '}).ok).toBe(false)
    const empty = validatePluginInstallForm({...base, publisher: '', version: ''})
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.message).toContain('插件 ID、发布者与版本号')
  })

  it('非法 JSON 与非数组声明被拒绝', () => {
    const badJson = validatePluginInstallForm({...base, rawPermissions: '{oops'})
    expect(badJson.ok).toBe(false)
    if (!badJson.ok) expect(badJson.message).toContain('权限声明 JSON')

    const notArray = validatePluginInstallForm({...base, rawTools: '{"name": "x"}'})
    expect(notArray.ok).toBe(false)
    if (!notArray.ok) expect(notArray.message).toContain('必须是数组')

    const badSkillJson = validatePluginInstallForm({...base, rawSkills: '[name]'})
    expect(badSkillJson.ok).toBe(false)
    if (!badSkillJson.ok) expect(badSkillJson.message).toContain('声明技能 JSON')
  })

  it('声明工具每项必须含字符串 name；声明技能每项必须含 name 与 content', () => {
    const toolNoName = validatePluginInstallForm({...base, rawTools: '[{"description": "d"}]'})
    expect(toolNoName.ok).toBe(false)
    if (!toolNoName.ok) expect(toolNoName.message).toContain('name')

    const skillNoContent = validatePluginInstallForm({...base, rawSkills: '[{"name": "a"}]'})
    expect(skillNoContent.ok).toBe(false)
    if (!skillNoContent.ok) expect(skillNoContent.message).toContain('content')

    const skillNotObject = validatePluginInstallForm({...base, rawSkills: '["x"]'})
    expect(skillNotObject.ok).toBe(false)
    if (!skillNotObject.ok) expect(skillNotObject.message).toContain('对象')
  })

  it('最小合法输入只产出必填三元组（可选键不出现）', () => {
    const result = validatePluginInstallForm(base)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload).toEqual({id: 'com.example.notes', publisher: 'aervox-official', version: '0.1.0'})
      expect('tools' in result.payload).toBe(false)
      expect('skills' in result.payload).toBe(false)
      expect('permissions' in result.payload).toBe(false)
    }
  })

  it('完整输入规范化：skills 缺省 description 不产生 undefined 键，工具原样透传', () => {
    const result = validatePluginInstallForm({
      ...base,
      rawPermissions: '["fs.read"]',
      rawTools: '[{"name": "search_notes", "category": "search", "safetyLevel": "read_only"}]',
      rawSkills: '[{"name": "note-taking", "content": "---\\ndescription: 记笔记\\n---\\n…"}, {"name": "b", "description": "另一样", "content": "x"}]',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.permissions).toEqual(['fs.read'])
      expect(result.payload.tools).toEqual([{name: 'search_notes', category: 'search', safetyLevel: 'read_only'}])
      expect(result.payload.skills).toEqual([
        {name: 'note-taking', content: '---\ndescription: 记笔记\n---\n…'},
        {name: 'b', description: '另一样', content: 'x'},
      ])
    }
  })
})
