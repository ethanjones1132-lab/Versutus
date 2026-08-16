export function createWindowsJob() {
  const children = [];
  return {
    children,
    terminated: false,
    add(child) {
      children.push(child);
    },
    async terminate() {
      this.terminated = true;
      for (const child of children) {
        if (child && typeof child.kill === 'function') {
          child.kill();
        }
      }
    },
  };
}
