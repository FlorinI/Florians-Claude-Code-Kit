import type { Register } from 'claude-code'

// The cc launcher loads this mod with --plugin-dir when it cannot append its own `/color <name>`
// prompt (a prompt of its own, the bare --resume picker, an argv ending in a list) and passes the color in CC_LAUNCH_COLOR. `/color` is
// queued and runs once the session is idle, before the launch prompt; it is not awaited, because
// session.start is awaited before the first prompt.
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    if (e.isInteractive) {
      const color = await $.env.get('CC_LAUNCH_COLOR')
      if (color && /^[A-Za-z]+$/.test(color)) {
        $.command.run({ command: 'color', args: color }).catch(() => {})
      }
    }
    return next(e)
  })
}
