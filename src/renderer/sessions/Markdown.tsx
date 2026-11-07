import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const PLUGINS = [remarkGfm]

/** Never followed in the app window: the main process hands it to the default browser. */
const Link: Components['a'] = ({ href, children }) => (
  <a href={href} onClick={(e) => {
    e.preventDefault()
    if (href) void window.canopy.openExternal(href).catch(() => undefined)
  }}>{children}</a>
)

/** Text from a session must not fetch anything by itself. */
const Image: Components['img'] = ({ alt }) => <span>{alt}</span>

const COMPONENTS: Components = { a: Link, img: Image }

/** Raw HTML is shown as text: no rehype-raw here, on purpose. */
export const Markdown = memo(function Markdown(props: { text: string }): React.JSX.Element {
  return <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>{props.text}</ReactMarkdown>
})
