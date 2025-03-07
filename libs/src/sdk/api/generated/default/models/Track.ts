// @ts-nocheck
/* tslint:disable */
/* eslint-disable */
/**
 * API
 * Audius V1 API
 *
 * The version of the OpenAPI document: 1.0
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */

import {
    RemixParent,
    RemixParentFromJSON,
    RemixParentFromJSONTyped,
    RemixParentToJSON,
} from './RemixParent';
import {
    TrackArtwork,
    TrackArtworkFromJSON,
    TrackArtworkFromJSONTyped,
    TrackArtworkToJSON,
} from './TrackArtwork';
import {
    User,
    UserFromJSON,
    UserFromJSONTyped,
    UserToJSON,
} from './User';

/**
 * 
 * @export
 * @interface Track
 */
export interface Track 
    {
        /**
        * 
        * @type {TrackArtwork}
        * @memberof Track
        */
        artwork?: TrackArtwork;
        /**
        * 
        * @type {string}
        * @memberof Track
        */
        description?: string;
        /**
        * 
        * @type {string}
        * @memberof Track
        */
        genre?: string;
        /**
        * 
        * @type {string}
        * @memberof Track
        */
        id: string;
        /**
        * 
        * @type {string}
        * @memberof Track
        */
        mood?: string;
        /**
        * 
        * @type {string}
        * @memberof Track
        */
        release_date?: string;
        /**
        * 
        * @type {RemixParent}
        * @memberof Track
        */
        remix_of?: RemixParent;
        /**
        * 
        * @type {number}
        * @memberof Track
        */
        repost_count: number;
        /**
        * 
        * @type {number}
        * @memberof Track
        */
        favorite_count: number;
        /**
        * 
        * @type {string}
        * @memberof Track
        */
        tags?: string;
        /**
        * 
        * @type {string}
        * @memberof Track
        */
        title: string;
        /**
        * 
        * @type {User}
        * @memberof Track
        */
        user: User;
        /**
        * 
        * @type {number}
        * @memberof Track
        */
        duration: number;
        /**
        * 
        * @type {boolean}
        * @memberof Track
        */
        downloadable?: boolean;
        /**
        * 
        * @type {number}
        * @memberof Track
        */
        play_count: number;
        /**
        * 
        * @type {string}
        * @memberof Track
        */
        permalink?: string;
        /**
        * 
        * @type {boolean}
        * @memberof Track
        */
        is_streamable?: boolean;
    }


