import fs from 'node:fs';
import path from 'node:path';
import { asHandlerMethod } from '@underload/service';

export const generationDeleteStory = asHandlerMethod(async (_, parameters) => {
    const { path: pathParams } = parameters;

    const storyId = pathParams.storyId;

    if (!storyId) {
        return {
            status: 400,
            response: { error: 'storyId is required' }
        };
    }

    // Resolve project root from this file's location
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
    const databaseDir = path.join(projectRoot, 'temporary', 'database', 'storyboard', storyId);

    if (!fs.existsSync(databaseDir)) {
        return {
            status: 404,
            response: { error: `Story '${storyId}' not found` }
        };
    }

    // Remove the entire story folder recursively
    fs.rmSync(databaseDir, { recursive: true, force: true });

    console.log(`Story '${storyId}' deleted (folder: ${databaseDir})`);

    return {
        status: 200,
        response: { success: true, storyId }
    };
});
