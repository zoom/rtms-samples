import * as audio from './audio/audioHelper.js';
import * as video from './video/videoHelper.js';
import * as audiovideo from './audiovideo/audiovideoHelper.js';
import { UUIDHelper } from './filename/UUIDHelper.js';
import * as network from './network/networkHelper.js';
import { FileLogger } from '../rtmsManager/utils/FileLogger.js';

export { FileLogger };

export const HelperManager = {
    audio,
    video,
    audiovideo,
    filename: UUIDHelper,
    network,
    utils: {
        FileLogger
    }
};

export default HelperManager;
