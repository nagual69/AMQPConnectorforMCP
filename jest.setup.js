// Silence expected error logs from negative tests to keep test output clean
const originalError = console.error;

beforeAll(() => {
  console.error = (...args) => {
    const first = args[0];
    if (typeof first === 'string' && (
      first.includes('Failed to parse message JSON') ||
      first.includes('Error handling message:')
    )) {
      return; // swallow expected errors from negative/validation tests
    }
    originalError(...args);
  };
});

afterAll(() => {
  console.error = originalError;
});
