interface TerminalWriter {
  write(data: string, callback: () => void): void;
}

export function writeTerminalWithCompletion(
  terminal: TerminalWriter,
  data: string,
  afterWrite: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let completed = false;
    try {
      terminal.write(data, () => {
        if (completed) return;
        completed = true;
        try {
          afterWrite();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      completed = true;
      reject(error);
    }
  });
}
