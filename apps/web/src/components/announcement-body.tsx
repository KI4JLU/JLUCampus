import { Fragment } from 'react'
import { paragraphsOf } from '@/lib/announcements'

/** An announcement's plain-text body: a paragraph per block, line breaks kept. */
export function AnnouncementBody({ body }: { body: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {paragraphsOf(body).map((lines, index) => (
        <p key={index}>
          {lines.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {lineIndex > 0 ? <br /> : null}
              {line}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  )
}
