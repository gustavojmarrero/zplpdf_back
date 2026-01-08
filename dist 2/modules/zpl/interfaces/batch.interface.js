export const BATCH_LIMITS = {
    free: {
        batchAllowed: false,
        maxFilesPerBatch: 0,
        maxFileSizeBytes: 0
    },
    pro: {
        batchAllowed: true,
        maxFilesPerBatch: 10,
        maxFileSizeBytes: 5 * 1024 * 1024
    },
    enterprise: {
        batchAllowed: true,
        maxFilesPerBatch: 50,
        maxFileSizeBytes: 10 * 1024 * 1024
    }
};

//# sourceMappingURL=batch.interface.js.map