// The phone menu cue (Nav.tsx navOverflow): a strip wider than its box overflows, and is "at the end" once its last
// tab is fully in the box. Pure arithmetic on the DOM's own numbers, so it is tested without a browser.
import { describe, expect, it } from 'vitest'
import { navOverflow, nextPageLeft } from './Nav'

describe('navOverflow', () => {
  it('a strip that fits does not overflow (a laptop: no attribute, no button, no fade)', () => {
    expect(navOverflow({ scrollLeft: 0, clientWidth: 1440, scrollWidth: 1440 })).toEqual({ overflows: false, atEnd: false })
    expect(navOverflow({ scrollLeft: 0, clientWidth: 1440, scrollWidth: 841 })).toEqual({ overflows: false, atEnd: false })
    // one pixel of rounding is not an overflow
    expect(navOverflow({ scrollLeft: 0, clientWidth: 841, scrollWidth: 842 }).overflows).toBe(false)
  })

  it('a phone strip overflows, and is at the end only once the last tab is in the box', () => {
    // 390 px phone: the strip is 841 px wide in a 302 px box beside the button
    expect(navOverflow({ scrollLeft: 0, clientWidth: 302, scrollWidth: 841 })).toEqual({ overflows: true, atEnd: false })
    expect(navOverflow({ scrollLeft: 242, clientWidth: 302, scrollWidth: 841 })).toEqual({ overflows: true, atEnd: false })
    expect(navOverflow({ scrollLeft: 539, clientWidth: 302, scrollWidth: 841 })).toEqual({ overflows: true, atEnd: true })
    // a fractional scroll position at the end (device pixels) still counts as the end
    expect(navOverflow({ scrollLeft: 538.5, clientWidth: 302, scrollWidth: 841 }).atEnd).toBe(true)
    expect(navOverflow({ scrollLeft: 530, clientWidth: 302, scrollWidth: 841 }).atEnd).toBe(false)
  })

  it('is safe on an unlaid-out or odd box', () => {
    expect(navOverflow({ scrollLeft: 0, clientWidth: 0, scrollWidth: 0 })).toEqual({ overflows: false, atEnd: false })
    expect(navOverflow({ scrollLeft: 0, clientWidth: 0, scrollWidth: 841 })).toEqual({ overflows: false, atEnd: false })
    expect(navOverflow({ scrollLeft: Number.NaN, clientWidth: 302, scrollWidth: 841 })).toEqual({ overflows: true, atEnd: false })
    expect(navOverflow({ scrollLeft: -20, clientWidth: 302, scrollWidth: 841 })).toEqual({ overflows: true, atEnd: false })
  })
})

describe('nextPageLeft', () => {
  // 390 px phone: an 840 px strip in a 302 px box (538 px hidden)
  const box = { clientWidth: 302, scrollWidth: 840 }
  it('pages by 80% of the box, so the last tab of the old view stays in sight', () => {
    expect(nextPageLeft({ ...box, scrollLeft: 0 })).toBe(242)
  })
  it('goes straight to the end when the page after this one would be a sliver (under a quarter of the box)', () => {
    // 242 + 242 = 484 would leave 54 px: the press goes to the end (538) instead, where the button reads "‹ Start"
    expect(nextPageLeft({ ...box, scrollLeft: 242 })).toBe(538)
    expect(navOverflow({ ...box, scrollLeft: nextPageLeft({ ...box, scrollLeft: 242 }) }).atEnd).toBe(true)
    // a narrower box keeps paging while a real page remains
    expect(nextPageLeft({ scrollLeft: 218, clientWidth: 272, scrollWidth: 840 })).toBe(436)
    expect(nextPageLeft({ scrollLeft: 436, clientWidth: 272, scrollWidth: 840 })).toBe(568)
  })
  it('never scrolls past the end or before the start', () => {
    expect(nextPageLeft({ ...box, scrollLeft: 538 })).toBe(538)
    expect(nextPageLeft({ scrollLeft: -10, clientWidth: 302, scrollWidth: 840 })).toBe(242)
    expect(nextPageLeft({ scrollLeft: 0, clientWidth: 841, scrollWidth: 840 })).toBe(0)
  })
})
