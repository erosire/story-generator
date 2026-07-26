import fs from 'node:fs';
import path from 'node:path';
import { asHandlerMethod } from '@underload/service';
import { resolveStoryboardDir } from './story-utils';

export const generationDeleteStory = asHandlerMethod(async (_, parameters, variables) => {
    const { path: pathParams } = parameters;

    const storyId = pathParams.storyId;

    if (!storyId) {
        return {
            status: 400,
            response: { error: 'storyId is required' }
        };
    }

    const databaseDir = resolveStoryboardDir(variables.root, storyId);

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
