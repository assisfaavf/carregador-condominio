import { useMemo } from 'react'

type StitchPageProps = {
  source: string
  pageId: string
}

type ParsedStitch = {
  bodyClassName: string
  bodyHtml: string
  styles: string[]
}

function normalizeStyle(css: string) {
  return css.replace(/\bbody\b/g, '.stitch-page')
}

function parseStitchHtml(source: string): ParsedStitch {
  const bodyMatch = source.match(/<body([^>]*)>([\s\S]*?)<\/body>/i)
  const bodyAttributes = bodyMatch?.[1] ?? ''
  const bodyClassMatch = bodyAttributes.match(/class=(['"])(.*?)\1/i)
  const bodyClassName = bodyClassMatch?.[2] ?? ''
  const bodyHtml = (bodyMatch?.[2] ?? source).replace(/<script[\s\S]*?<\/script>/gi, '')

  const styleMatches = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
  const styles = [...new Set(styleMatches.map((match) => normalizeStyle(match[1].trim())).filter(Boolean))]

  return {
    bodyClassName,
    bodyHtml,
    styles,
  }
}

export default function StitchPage({ source, pageId }: StitchPageProps) {
  const parsed = useMemo(() => parseStitchHtml(source), [source])
  const className = ['stitch-page', parsed.bodyClassName].filter(Boolean).join(' ')

  return (
    <>
      {parsed.styles.map((css, index) => (
        <style
          dangerouslySetInnerHTML={{ __html: css }}
          key={`${pageId}-style-${index + 1}`}
        />
      ))}
      <div
        className={className}
        dangerouslySetInnerHTML={{ __html: parsed.bodyHtml }}
      />
    </>
  )
}
