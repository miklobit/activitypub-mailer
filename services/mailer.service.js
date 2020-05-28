const mailer = require('nodemailer');
const Handlebars = require('handlebars');
const fs = require('fs').promises;
const { ACTIVITY_TYPES } = require('@semapps/activitypub');
const CONFIG = require('../config');

const MailerService = {
  name: 'mailer',
  dependencies: ['match-bot', 'activitypub.actor', 'mail-queue', 'external-resource'],
  settings: {
    baseUri: CONFIG.HOME_URL,
    fromEmail: CONFIG.FROM_EMAIL,
    fromName: CONFIG.FROM_NAME,
    smtpServer: {
      host: CONFIG.SMTP_HOST,
      port: 465,
      secure: true,
      auth: {
        user: CONFIG.SMTP_USER,
        pass: CONFIG.SMTP_PASS
      }
    },
    // Set automatically
    matchBotUri: null
  },
  async started() {
    this.settings.matchBotUri = await this.broker.call('match-bot.getUri');

    if (this.settings.smtpServer.host === 'smtp.ethereal.email') {
      const testAccount = await mailer.createTestAccount();
      this.settings.smtpServer.auth.user = testAccount.user;
      this.settings.smtpServer.auth.pass = testAccount.pass;
      this.settings.smtpServer.port = testAccount.smtp.port;
      this.settings.smtpServer.secure = testAccount.smtp.secure;
    }

    this.transporter = mailer.createTransport(this.settings.smtpServer);

    const confirmationMailFile = await fs.readFile(__dirname + '/../templates/confirmation-mail.html');
    this.confirmationMailTemplate = Handlebars.compile(confirmationMailFile.toString());

    const notificationMailFile = await fs.readFile(__dirname + '/../templates/notification-mail.html');
    this.notificationMailTemplate = Handlebars.compile(notificationMailFile.toString());
  },
  actions: {
    async processQueue(ctx) {
      const { frequency } = ctx.params;
      let returnInfo = [];

      const container = await this.broker.call('mail-queue.find', {
        query: {
          'http://semapps.org/ns/core#frequency': frequency,
          'http://semapps.org/ns/core#sentAt': null,
          'http://semapps.org/ns/core#errorResponse': null
        }
      });

      if (container['ldp:contains'] && container['ldp:contains'].length > 0) {
        for (let mail of container['ldp:contains']) {
          const info = await this.actions.sendNotificationMail({ mail });

          if (info.accepted.length > 0) {
            // Mark mail as sent
            await this.broker.call('mail-queue.update', {
              '@id': mail['@id'],
              sentAt: new Date().toISOString()
            });
          } else {
            // Mark mail as error
            await this.broker.call('mail-queue.update', {
              '@id': mail['@id'],
              errorResponse: info.response
            });
          }

          returnInfo.push(info);
        }
      }

      return returnInfo;
    },
    async sendNotificationMail(ctx) {
      const { mail } = ctx.params;

      const actor = await this.broker.call('activitypub.actor.get', { id: mail['actor'] });
      const themes = await this.broker.call('external-resource.getMany', { ids: actor['pair:hasInterest'] });
      const projects = await this.broker.call('external-resource.getMany', { ids: mail.objects });

      const html = this.notificationMailTemplate({
        projects: projects,
        locationParam: actor.location ? `A ${actor.location.radius / 1000} km de chez vous` : 'Dans le monde entier',
        themeParam: `Concernant les thématiques: ${themes.map(theme => theme['pair:preferedLabel']).join(', ')}`,
        preferencesUrl: this.settings.baseUri + '?id=' + actor.id,
        email: actor['pair:e-mail']
      });

      return await this.transporter.sendMail({
        from: `"${this.settings.fromName}" <${this.settings.fromEmail}>`,
        to: actor['pair:e-mail'],
        subject: 'Nouveaux projets sur la Fabrique',
        // text: "Hello world",
        html
      });
    },
    async sendConfirmationMail(ctx) {
      const { actor } = ctx.params;
      const themes = await this.broker.call('external-resource.getMany', { ids: actor['pair:hasInterest'] });

      const html = this.confirmationMailTemplate({
        locationParam: actor.location ? `A ${actor.location.radius / 1000} km de chez vous` : 'Dans le monde entier',
        themeParam: `Concernant les thématiques: ${themes.map(theme => theme['pair:preferedLabel']).join(', ')}`,
        frequency: actor['semapps:mailFrequency'] === 'daily' ? 'une fois par jour' : 'une fois par semaine',
        preferencesUrl: this.settings.baseUri + '?id=' + actor.id,
        email: actor['pair:e-mail']
      });

      return await this.transporter.sendMail({
        from: `"${this.settings.fromName}" <${this.settings.fromEmail}>`,
        to: actor['pair:e-mail'],
        subject: 'Notification des nouveaux projets sur la Fabrique',
        // text: "Hello world",
        html
      });
    }
  },
  events: {
    async 'activitypub.inbox.received'({ activity, recipients }) {
      if (
        activity.actor === this.settings.matchBotUri &&
        activity.type === ACTIVITY_TYPES.ANNOUNCE &&
        (activity.object.type === ACTIVITY_TYPES.CREATE || activity.object.type === ACTIVITY_TYPES.UPDATE)
      ) {
        for (let actorUri of recipients) {
          const actor = await this.broker.call('activitypub.actor.get', { id: actorUri });
          await this.queueObject(actor, { '@context': activity['@context'], ...activity.object.object });
        }
        this.broker.emit('mailer.objects.queued');
      }
    },
    'mailer.objects.queued'() {
      // Do nothing
    }
  },
  methods: {
    async queueObject(actor, object) {
      // Find if there is a mail in queue for the actor
      const mails = await this.broker.call('mail-queue.find', {
        query: {
          'http://semapps.org/ns/core#actor': actor.id,
          'http://semapps.org/ns/core#sentAt': null,
          'http://semapps.org/ns/core#errorResponse': null
        }
      });

      if (mails['ldp:contains'] && mails['ldp:contains'].length > 0) {
        const mail = mails['ldp:contains'][0];
        const objects = Array.isArray(mail.objects) ? mail.objects : [mail.objects];

        // Add the object to the existing mail
        await this.broker.call('mail-queue.update', {
          '@id': mail['@id'],
          objects: [...new Set([object.id, ...objects])]
        });
      } else {
        // Create a new mail for the actor
        await this.broker.call('mail-queue.create', {
          '@type': 'Mail',
          actor: actor.id,
          objects: object.id,
          frequency: actor['semapps:mailFrequency'],
          sentAt: null,
          errorResponse: null
        });
      }
    }
  }
};

module.exports = MailerService;
