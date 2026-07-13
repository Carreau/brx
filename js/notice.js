// Tiny non-blocking notice/confirm chip — replaces alert()/confirm().
//   showNotice('message')                       -> auto-dismissing toast
//   showNotice('Sure?', [{label, value, danger}]) -> confirm; resolves with the
// tapped action's value, or null on Cancel / dismiss / replacement.
// { cancel: false } drops the Cancel button (e.g. a single acknowledge action).

let dismiss = null; // resolver of the currently shown chip

export function showNotice(message, actions = [], { cancel = actions.length > 0 } = {}) {
  dismiss?.(null); // only one chip at a time
  return new Promise((resolve) => {
    const chip = document.createElement('div');
    chip.className = 'panel notice-chip';
    chip.append(Object.assign(document.createElement('span'), { textContent: message }));

    const done = (value) => {
      if (dismiss === done) dismiss = null;
      chip.remove();
      resolve(value);
    };
    dismiss = done;

    for (const a of actions) {
      const b = Object.assign(document.createElement('button'), { textContent: a.label });
      if (a.danger) b.className = 'danger';
      b.onclick = () => done(a.value);
      chip.append(b);
    }
    if (cancel) {
      const c = Object.assign(document.createElement('button'), { textContent: 'Cancel' });
      c.onclick = () => done(null);
      chip.append(c);
    }
    if (!actions.length) setTimeout(() => done(null), 6000);
    document.body.append(chip);
  });
}
