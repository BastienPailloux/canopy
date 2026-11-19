import { describe, expect, it } from 'vitest'
import { rankPaths } from '../../src/renderer/code/fileMatch'

describe('rankPaths', () => {
  it('keeps only the paths holding the characters of the query in order, ignoring case', () => {
    expect(rankPaths(['src/Alpha.ts', 'src/beta.ts', 'lib/pal.ts'], 'ALP')).toEqual(['src/Alpha.ts'])
    expect(rankPaths(['src/a.ts'], '')).toEqual([])
  })

  it('puts the file named like the query before files that only contain its letters', () => {
    const paths = ['docs/superpowers/archive/search-notes.md', 'src/sessions/actions/archive.ts', 'src/main/code/search.ts']
    expect(rankPaths(paths, 'search')[0]).toBe('src/main/code/search.ts')
  })

  it('ranks a name match, then a name prefix, then a name substring, then a path substring, then scattered letters', () => {
    const paths = [
      'src/s/e/a/r/c/h.ts',
      'src/research/index.ts',
      'src/research.ts',
      'src/searchPanel.ts',
      'src/search.ts'
    ]
    expect(rankPaths(paths, 'search')).toEqual([
      'src/search.ts',
      'src/searchPanel.ts',
      'src/research.ts',
      'src/research/index.ts',
      'src/s/e/a/r/c/h.ts'
    ])
  })

  it('prefers letters that start words of the name (camelCase, separators) over letters lost in the middle', () => {
    const paths = ['src/renderer/code/superprompt.ts', 'src/renderer/code/SearchPanel.tsx']
    expect(rankPaths(paths, 'sp')).toEqual(['src/renderer/code/SearchPanel.tsx', 'src/renderer/code/superprompt.ts'])
    expect(rankPaths(['src/fast-run.ts', 'src/firstrun.ts'], 'fr')[0]).toBe('src/fast-run.ts')
  })

  it('prefers letters close together over letters spread far apart', () => {
    const paths = ['src/xaxxxxxxxxbxc.ts', 'src/xxaxbxcxxxxxxxxx.ts']
    expect(rankPaths(paths, 'abc')[0]).toBe('src/xxaxbxcxxxxxxxxx.ts')
  })

  it('matches a query holding a slash against the folders, the closest fit first', () => {
    const paths = ['tests/main/code/search.test.ts', 'src/main/code/search.ts', 'src/renderer/code/SearchPanel.tsx']
    expect(rankPaths(paths, 'main/code/se')).toEqual(['src/main/code/search.ts', 'tests/main/code/search.test.ts'])
  })

  it('breaks ties with the shorter path, then the alphabet', () => {
    expect(rankPaths(['src/deep/down/app.ts', 'src/b/app.ts', 'src/a/app.ts'], 'app')).toEqual(['src/a/app.ts', 'src/b/app.ts', 'src/deep/down/app.ts'])
  })

  it('takes only the last extension off a name: a file with a dotted name is not named like its first part', () => {
    expect(rankPaths(['src/main/code/search.ts', 'a/search.test.ts'], 'search')).toEqual(['src/main/code/search.ts', 'a/search.test.ts'])
    expect(rankPaths(['src/search.tsx', 'src/main/code/search.test.ts'], 'search.test')[0]).toBe('src/main/code/search.test.ts')
    expect(rankPaths(['config/.envrc', 'x/.env'], '.env')[0]).toBe('x/.env')
  })

  it('survives names whose lowercase is longer than the name', () => {
    expect(rankPaths(['src/İ.ts'], 's')).toEqual(['src/İ.ts'])
    expect(rankPaths(['src/İnfo.ts'], 'nf')).toEqual(['src/İnfo.ts'])
  })

  it('stops at the limit', () => {
    expect(rankPaths(['a1', 'a2', 'a3'], 'a', 2)).toHaveLength(2)
  })
})
