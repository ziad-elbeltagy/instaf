const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../config/config');

class InstagramService {
    constructor() {
        this.options = {
            apiTimeout: config.API.TIMEOUT_MS,
            imageFetchTimeout: config.API.IMAGE_FETCH_TIMEOUT_MS,
            apiUrlBase: config.API.INSTAGRAM_API_URL_BASE
        };
    }

    async fetchProfileData(username) {
        logger.info(`Fetching profile data for @${username}...`);
        try {
            const apiData = await this._fetchFromAPI(username);
            let profileData = this._parseApiResponse(apiData, username);

            if (profileData.apiResponseJson && profileData.apiResponseJson.status === true && profileData.userProfilePic) {
                profileData.userProfilePicHash = await this._getImageHash(profileData.userProfilePic);
            }

            return { success: true, data: profileData, timestamp: new Date().toISOString() };
        } catch (error) {
            logger.error(`Error fetching profile data for @${username}: ${error.message}`);
            return { success: false, error: error.message, timestamp: new Date().toISOString() };
        }
    }

    async fetchStoryData(username) {
        const apiUrl = `https://content.mollygram.com/?url=${encodeURIComponent(username)}&method=allstories`;
        logger.info(`Fetching story data for @${username} from: ${apiUrl}`);
        try {
            const response = await axios.get(apiUrl, { timeout: 15000 });
            const data = response.data;
            
            if (data && data.status === 'ok' && data.html) {
                const mediaData = this._extractMediaUrl(data.html);
                if (mediaData.url) {
                    return { 
                        status: 'ok', 
                        mediaType: mediaData.type,
                        mediaUrl: mediaData.url 
                    };
                }
                return { status: 'error', msg: 'No media URL found in story HTML.' };
            } 
            
            if (data && data.status === 'error' && data.msg && data.msg.includes('no stories')) {
                return { status: 'no_stories', msg: data.msg };
            }
            
            return { status: 'error', msg: data && data.msg ? data.msg : 'Unknown error from story API.' };
        } catch (error) {
            logger.error(`Error fetching/parsing story for @${username}: ${error.message}`);
            return { status: 'error', msg: error.message };
        }
    }

    async _fetchFromAPI(username) {
        const apiUrl = `${this.options.apiUrlBase}?username=${encodeURIComponent(username)}`;
        logger.debug(`Calling Instagram API for @${username}: ${apiUrl}`);
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.options.apiTimeout);

            const response = await fetch(apiUrl, {
                method: "GET",
                headers: {
                    "Origin": "https://www.tucktools.com",
                    "Referer": "https://www.tucktools.com/",
                    "User-Agent": "Mozilla/5.0 (compatible; InstagramMonitorBot/1.0)",
                },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`API request failed for @${username} (status ${response.status})`);
            }
            return await response.json();
        } catch (error) {
            throw error;
        }
    }

    _parseApiResponse(apiData, targetUsername) {
        if (!apiData || apiData.status !== true) {
            return {
                username: targetUsername.toLowerCase(),
                scrapedUsername: targetUsername.toLowerCase(),
                userFullname: null, userDescription: null, userProfilePic: null, userProfilePicHash: null,
                isPrivate: null, followersCount: 0, followingCount: 0, postsCount: 0, isVerified: null,
                rawFollowers: '0', rawFollowing: '0', rawPosts: '0',
                apiResponseJson: apiData || { status: false, message: "No valid data from API" },
            };
        }

        return {
            username: targetUsername.toLowerCase(),
            scrapedUsername: (apiData.username || targetUsername).toLowerCase(),
            userFullname: apiData.user_fullname || null,
            userDescription: apiData.user_description || null,
            userProfilePic: apiData.user_profile_pic || null,
            userProfilePicHash: null,
            isPrivate: apiData.is_private === true,
            followersCount: parseInt(apiData.user_followers, 10) || 0,
            followingCount: parseInt(apiData.user_following, 10) || 0,
            postsCount: parseInt(apiData.total_posts, 10) || 0,
            isVerified: apiData.is_verified === true,
            rawFollowers: String(apiData.user_followers || '0'),
            rawFollowing: String(apiData.user_following || '0'),
            rawPosts: String(apiData.total_posts || '0'),
            apiResponseJson: apiData,
        };
    }

    async _getImageHash(url) {
        if (!url) return null;
        
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: this.options.imageFetchTimeout
            });
            
            if (response.status === 200 && response.data) {
                return crypto.createHash('md5').update(response.data).digest('hex');
            }
            return null;
        } catch (error) {
            logger.warn(`Error fetching/hashing image: ${error.message}`);
            return null;
        }
    }

    _extractMediaUrl(html) {
        const { JSDOM } = require('jsdom');
        const dom = new JSDOM(html);
        const doc = dom.window.document;

        // Try video source first
        const sourceElement = doc.querySelector('video > source[type="video/mp4"]');
        if (sourceElement && sourceElement.src) {
            return { type: 'video', url: sourceElement.src };
        }

        // Try download link for video
        const downloadLink = doc.querySelector('a.btn.bg-gradient-success[href]');
        if (downloadLink && downloadLink.href && downloadLink.href.endsWith('.mp4')) {
            return { type: 'video', url: downloadLink.href };
        }

        // Try generic MP4 links
        const genericVideoLink = doc.querySelector('a[href$=".mp4"], video > source[src$=".mp4"]');
        if (genericVideoLink) {
            return { type: 'video', url: genericVideoLink.href || genericVideoLink.src };
        }

        // Try image sources
        const imgElement = doc.querySelector('img.story-image');
        if (imgElement && imgElement.src) {
            return { type: 'photo', url: imgElement.src };
        }

        // Try generic image links
        const imageLink = doc.querySelector('a[href$=".jpg"], a[href$=".jpeg"], a[href$=".png"]');
        if (imageLink && imageLink.href) {
            return { type: 'photo', url: imageLink.href };
        }

        // If no media found
        return { type: null, url: null };
    }
}

module.exports = InstagramService;
