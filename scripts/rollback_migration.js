// Destructive rollback is intentionally unavailable until a batch-scoped,
// independently verified migration with before-images is implemented.
console.error('Rollback disabled: restore a verified backup using an approved recovery procedure.');
process.exitCode = 1;
