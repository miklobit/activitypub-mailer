const urlJoin = require('url-join');
const { BotService, ACTIVITY_TYPES, PUBLIC_URI } = require('@semapps/activitypub');
const CONFIG = require('../config');

const MatchBotService = {
  name: 'match-bot',
  mixins: [BotService],
  settings: {
    actor: {
      username: 'match-bot',
      name: 'Match Bot'
    }
  },
  actions: {
    async followActor(ctx) {
      await ctx.call('activitypub.outbox.post', {
        username: this.settings.actor.username,
        '@context': 'https://www.w3.org/ns/activitystreams',
        actor: this.settings.actor.uri,
        type: ACTIVITY_TYPES.FOLLOW,
        object: CONFIG.FOLLOWING,
        to: [CONFIG.FOLLOWING, urlJoin(this.settings.actor.uri, 'followers')]
      });

      console.log('Match bot now follows actor', CONFIG.FOLLOWING);
    }
  },
  methods: {
    actorCreated(actor) {
      if (CONFIG.FOLLOWING) {
        this.actions.followActor();
      }
    },
    async inboxReceived(activity) {
      if (CONFIG.MONITORED_ACTIVITY_TYPES.includes(activity.type)) {
        const matchingFollowers = await this.getMatchingFollowers(activity);

        await this.broker.call('activitypub.outbox.post', {
          collectionUri: this.settings.actor.uri + '/outbox',
          '@context': activity['@context'],
          actor: this.settings.actor.uri,
          to: [PUBLIC_URI, ...matchingFollowers],
          type: ACTIVITY_TYPES.ANNOUNCE,
          object: activity
        });
      }
    },
    async getMatchingFollowers(activity) {
      let matchingFollowers = [],
        actor;
      const actors = await this.getFollowers();

      for (let actorUri of actors) {
        try {
          actor = await this.broker.call('activitypub.actor.get', { id: actorUri });
        } catch (e) {
          // Actor not found
          actor = null;
        }
        if (actor && this.matchInterests(activity.object, actor)) {
          if (this.matchLocation(activity.object, actor)) {
            matchingFollowers.push(actor.id);
          }
        }
      }

      return matchingFollowers;
    },
    matchInterests(object, actor) {
      const actorInterests = Array.isArray(actor['pair:hasInterest'])
        ? actor['pair:hasInterest']
        : [actor['pair:hasInterest']];
      const activityInterests = Array.isArray(object['pair:interestOf'])
        ? object['pair:interestOf']
        : [object['pair:interestOf']];
      return actorInterests.filter(theme => activityInterests.includes(theme)).length > 0;
    },
    matchLocation(object, actor) {
      // If no location is set for the actor, we assume he wants to be notified of all objects
      if (!actor.location || !actor.location.latitude) return true;
      // If no location is set for the object but actor want a notification by location, do not match
      if (!object.location || !object.location.latitude) return false;
      const distance = this.distanceBetweenPoints(
        parseFloat(actor.location.latitude),
        parseFloat(actor.location.longitude),
        parseFloat(object.location.latitude),
        parseFloat(object.location.longitude)
      );
      return distance <= parseFloat(actor.location.radius) / 1000;
    },
    distanceBetweenPoints(lat1, lon1, lat2, lon2) {
      // Taken from https://stackoverflow.com/a/21623206/7900695
      const p = 0.017453292519943295; // Math.PI / 180
      const c = Math.cos;
      const a = 0.5 - c((lat2 - lat1) * p) / 2 + (c(lat1 * p) * c(lat2 * p) * (1 - c((lon2 - lon1) * p))) / 2;
      return 12742 * Math.asin(Math.sqrt(a)); // 2 * R; R = 6371 km
    }
  }
};

module.exports = MatchBotService;
