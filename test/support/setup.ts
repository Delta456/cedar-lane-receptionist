// Loaded before every test file (see the "test" script). Tests that check
// logging pass their own level, so the default here only keeps output quiet.
process.env.LOG_LEVEL ??= 'silent';
