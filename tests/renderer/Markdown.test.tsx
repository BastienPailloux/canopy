import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../../src/renderer/sessions/Markdown'

const html = (text: string): string => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown', () => {
  it('renders code blocks, inline code, lists and tables', () => {
    const out = html('```ts\nconst a = 1\n```\n\nun `mot`\n\n- item\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(out).toContain('<pre><code class="language-ts">const a = 1')
    expect(out).toContain('<code>mot</code>')
    expect(out).toContain('<li>item</li>')
    expect(out).toContain('<table>')
    expect(out).toContain('<td>2</td>')
  })

  it('never renders raw HTML', () => {
    const out = html('<img src=x onerror=alert(1)>\n\n<b>gras</b> <script>alert(1)</script>')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<b>')
    expect(out).not.toContain('<script')
  })

  it('loads no remote image, and keeps its description', () => {
    const out = html('![un schéma](https://exemple.test/a.png)')
    expect(out).not.toContain('<img')
    expect(out).toContain('un schéma')
  })

  it('keeps web links, and drops dangerous targets', () => {
    expect(html('[site](https://exemple.test/)')).toContain('href="https://exemple.test/"')
    expect(html('[piège](javascript:alert(1))')).not.toContain('javascript:')
  })
})
