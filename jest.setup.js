// Silence expected JSON parse errors from negative tests to keep test output clean
const originalError = console.error;

beforeAll(() => {
  console.error = (...args) => {
    const first = args[0];
    if (typeof first === 'string' && first.includes('Failed to parse message JSON')) {
      return; // swallow expected parse errors from parseMessage tests
    }
    originalError(...args);
  };
});

afterAll(() => {
  console.error = originalError;
});
