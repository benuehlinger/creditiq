/**
 * The icon set. Eight strokes, drawn once.
 *
 * Status and direction were carried by Unicode glyphs: ✓ ✕ ▲ ⓘ → ←. They
 * render from whichever symbol font the machine has, at whatever weight and
 * baseline that font chose, so a tick sat heavy beside light text on one
 * machine and thin on another, and the circled i came out as a full-width
 * character on Windows. An inline SVG on `currentColor` takes the text's
 * colour and sits on its baseline everywhere.
 */
import type { SVGProps } from 'react'

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const, 'aria-hidden': true, ...props,
})

export const Check = (p: SVGProps<SVGSVGElement>) =>
  <svg {...base(p)}><path d="M3 8.5l3 3 7-7" /></svg>
export const Cross = (p: SVGProps<SVGSVGElement>) =>
  <svg {...base(p)}><path d="M4 4l8 8M12 4l-8 8" /></svg>
export const Alert = (p: SVGProps<SVGSVGElement>) =>
  <svg {...base(p)}><path d="M8 2.5L14.5 13.5H1.5L8 2.5z" /><path d="M8 7v3M8 11.6v.1" /></svg>
export const Bang = (p: SVGProps<SVGSVGElement>) =>
  <svg {...base(p)}><circle cx="8" cy="8" r="6.2" /><path d="M8 5v3.5M8 11v.1" /></svg>
export const Info = (p: SVGProps<SVGSVGElement>) =>
  <svg {...base(p)}><circle cx="8" cy="8" r="6.2" /><path d="M8 7.5V11M8 5.2v.1" /></svg>
export const ArrowRight = (p: SVGProps<SVGSVGElement>) =>
  <svg {...base(p)}><path d="M3 8h10M9 4l4 4-4 4" /></svg>
export const ArrowLeft = (p: SVGProps<SVGSVGElement>) =>
  <svg {...base(p)}><path d="M13 8H3M7 4L3 8l4 4" /></svg>
export const ArrowUp = (p: SVGProps<SVGSVGElement>) =>
  <svg {...base(p)}><path d="M8 13V3M4 7l4-4 4 4" /></svg>
export const ArrowDown = (p: SVGProps<SVGSVGElement>) =>
  <svg {...base(p)}><path d="M8 3v10M4 9l4 4 4-4" /></svg>
export const Close = (p: SVGProps<SVGSVGElement>) =>
  <svg {...base(p)}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>

/** The icon for a status, so every status mark in the app is the same mark. */
export function StatusIcon({ severity, ...p }: SVGProps<SVGSVGElement> & {
  severity: 'good' | 'warning' | 'serious' | 'critical'
}) {
  const I = { good: Check, warning: Bang, serious: Alert, critical: Cross }[severity]
  return <I {...p} />
}
