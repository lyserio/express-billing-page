const moment 	= require("moment")
const Stripe 	= require("stripe")
const express 	= require("express")
const router 	= express.Router()
const ejs 		= require("ejs")
let stripe = null
let options = {}

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

router.post('/webhook', asyncHandler(async (req, res, next) => {

	if (!stripe) stripe = Stripe(options.secretKey)

	// Make sure event is signed
	// let sig = req.header("stripe-signature")

	// Will fail if event doesn't exist
	let event = await stripe.events.retrieve(req.body.id)

	let type = event.type
	console.log('Stripe said: '+type)

	if (type === 'customer.subscription.trial_will_end') {
		
		// Send email for ending trial
		// sendMail(`Your trial is ending - ${options.siteName}`, `Hello,\n\nThis is an email to let you know that your ${options.siteName} trial will be ending soon.\n\nIf you do not wish to continue, you can cancel your subscription now in your dashboard. Else, you don't have anything to do :)\n\nCheers`, dbUser.email)

	} else if (type === 'customer.source.expiring') {

		// Send email for credit card expiring
		// Already handled by Stripe

	} else if (type === 'invoice.payment_failed') {
		
		// Send email for failed invoice payment
		// Already handled by Stripe
	
	} else if (type === 'invoice.payment_succeeded') {

		// what about downgrade
		const invoice 			= event.data.object
		const reason 			= invoice.billing_reason
		const customerId 		= invoice.customer
		const subscriptionId 	= invoice.subscription

		const subscription 		= await stripe.subscriptions.retrieve(subscriptionId)
		const planId 			= subscription.metadata.planId
		const plan 				= options.plans.find(p => p.id === planId)

		// Only triggers on upgrading or creating subscription
		if (reason === 'subscription_create' || reason === 'subscription_update') {
			
			let user = await options.mongoUser.findOne({ 'stripe.customerId': customerId }).exec()

			if (options.onUpgrade && typeof options.onUpgrade === 'function') options.onUpgrade(user, planId)

			sendMail("Thank you for upgrading", 
`Hello,\n
This is a confirmation email that you have successfully upgraded your account to the ${plan.name} plan.\n
If you have any question or suggestion, simply reply to this email.\n
Glad to have you on board :)`, user.email)

		}
	
	} else if (type === 'customer.subscription.updated') {
		
		// Triggers when the billing period ends and a new billing period begins, when switching from one plan to another, or switching status from trial to active

		// Either ones of these status means the user has the right to access the product
		const acceptableStatus = ['trialing', 'active', 'incomplete', 'past_due']
		
		const subscription 	= event.data.object
		const currentStatus = subscription.status
		const planId 		= subscription.metadata.planId
		const customer 		= subscription.customer
		
		let user = await options.mongoUser.findOne({'stripe.customerId': customer}).exec()

		if (user.stripe.subscriptionStatus) user.stripe.subscriptionStatus = currentStatus

		if (user.plan) {
			if (acceptableStatus.includes(currentStatus)) {
				 user.plan = planId
			} else {
				user.plan = 'free'
			}
		}

		if (options.onSubscriptionChange && typeof options.onSubscriptionChange === 'function') options.onSubscriptionChange(user)

		await user.save()
			
	} else if (type === 'customer.subscription.deleted') {

		const subscription 	= event.data.object
		const customerId 	= subscription.customer

		let user = await options.mongoUser.findOne({'stripe.customerId': customerId}).exec()
		
		if (user.plan) user.plan = 'free'
		user.stripe.subscriptionId = null
		user.stripe.subscriptionItems = []
		user.stripe.canceled = false
		await user.save()

		sendMail(`Subscription canceled - ${options.siteName}`, 
`Hello,\n
This is an automatic email to inform that your ${options.siteName} subscription was canceled.
${options.cancelMailExtra ? options.cancelMailExtra + '\n' : ''}
We hope to see you back soon!`, user.email)

	} else {
		// Won't act on it
	}

	res.send({ received: true })
}))

const billingInfos = async (customerId, user, context, getInvoices=true) => {


	let userPlan = options.plans.find(p => p.id === user.plan)
	let upgradablePlans = []
	
	if (context === 'choosepage') {
		// All the plans except the one we currently are (usually the free plan)
		upgradablePlans = options.plans.filter(p => options.allowNoUpgrade ? true : p.id !== user.plan)
	} else {
		// In this case it's for the upgrade modal 
		// Which means we don't show the free plan or even the current plan
		upgradablePlans = options.plans.filter(p => p.id !== 'free' && p.id !== user.plan)
	}

	if (userPlan) {
		for (let plan of upgradablePlans) {
			if (plan.order > userPlan.order) plan.isHigher = true
			else if (plan.order < userPlan.order) plan.isLower = true
		}
	}

	if (!customerId) {
		return {
			paymentMethods: [],
			invoices: [],
			upgradablePlans: upgradablePlans,
			userPlan: userPlan,
			subscriptions: [],
			user: user,
			options: options
		}
	}

	let stripeCustomer = await stripe.customers.retrieve(customerId, {expand: ['subscriptions.data.plan.product']})
	let paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' })

	let subscriptions = stripeCustomer.subscriptions.data

	paymentMethods = paymentMethods.data.map((m) => {
		if (m.id === stripeCustomer.invoice_settings.default_payment_method || 
			m.id === stripeCustomer.default_source) { // default_source will be deprecated (i think)
			m.isDefault = true
		}

		return m
	})

	subscriptions = subscriptions.map(sub => {

		sub.currentPeriodStart = moment(sub.current_period_start * 1000).format("ll")
		sub.currentPeriodEnd = moment(sub.current_period_end * 1000).format("ll")
		
		if (sub.plan) { 
			sub.plan.amount = (sub.plan.amount / 100).toLocaleString('en-US', { 
				style: 'currency', 
				currency: 'USD'
			})

			sub.unitLabel = sub.plan.product.unit_label
			sub.name = sub.plan.product.name
		}

		if (sub.discount && sub.discount.coupon) {
			let coupon = sub.discount.coupon

			sub.discountDescription = `${coupon.name}: -${coupon.percent_off ? coupon.percent_off + '%' : coupon.amount_off + ' ' + coupon.currency} for ${coupon.duration_in_months} months`
		}

		return sub
	})

	if (getInvoices) {

		var allInvoices = await stripe.invoices.list({
			customer: customerId,
			limit: 5 
		})

		if (options.showDraftInvoice) {
			try {
				let upcomingInvoice = await stripe.invoices.retrieveUpcoming(customerId)
				allInvoices.data.unshift(upcomingInvoice)
			} catch(e) {
				// No upcoming invoices
			}
		}

		allInvoices = allInvoices.data
		.filter(invoice => invoice.amount_due > 0) // Only show 'real' invoices 
		.map(invoice => {
			invoice.amount = (invoice.amount_due / 100).toLocaleString('en-US', { 
				style: 'currency', 
				currency: 'USD'
			})

			// Because the invoice's own period isn't correct for the first invoice, we use the one from the first item
			invoice.cleanPeriodEnd = moment(invoice.lines.data[0].period.end * 1000).format('ll')
			invoice.cleanPeriodStart = moment(invoice.lines.data[0].period.start * 1000).format('ll')

			invoice.date = moment(invoice.date * 1000).format('ll')
			invoice.unpaid = (invoice.attempt_count > 1 && !invoice.paid)

			return invoice
		})

	}

	return {
		paymentMethods: paymentMethods,
		upgradablePlans: upgradablePlans,
		userPlan: userPlan,
		invoices: getInvoices ? allInvoices : null,
		subscriptions: subscriptions,
		user: user,
		options: options
	}

}

router.use((req, res, next) => {
	if (!req.user) return next('Login required for billing.')

	res.locals.customerId = req.user.stripeCustomerId || (req.user.stripe ? req.user.stripe.customerId : null)
	res.locals.subscriptionId = req.user.subscription || (req.user.stripe ? req.user.stripe.subscriptionId : null)
	
	if (!stripe) stripe = Stripe(options.secretKey)

	next()
})

router.get('/', asyncHandler(async (req, res, next) => {

	const customerId = res.locals.customerId
	const data = await billingInfos(customerId, req.user)

	res.render(__dirname+'/views/billing.ejs', data)
}))

router.get('/testcoupon', (req, res, next) => {

	let coupons = options.coupons
	let couponToTest = req.query.code

	let exist = coupons && coupons.find(c => c.code === couponToTest)

	if (!exist) return res.send({ valid: false })

	res.send({
		valid: true,
		description: exist.description
	})
})

// Adds a card to customer, which is created if it doesn't exist
// Accepts either a paymentMethodId or a cardToken directly from Elements
// returns the Stripe Customer ID
const addCardToCustomer = async (user, customerId, paymentMethodId, cardToken) => {
	
	let customer = null

	if (customerId) {

		if (paymentMethodId) {
			// Attach and set as default
			await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId })
			await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } })
		} else {
			await stripe.customers.update(customerId, { source: cardToken })
		}

		return customerId
	} 

	if (paymentMethodId) {
		customer = await stripe.customers.create({ email: user.email, payment_method: paymentMethodId })
	} else {
		customer = await stripe.customers.create({ email: user.email, source: cardToken })
	}

	let dbUser = await options.mongoUser.findById(user.id).exec()
	
	dbUser.stripe.customerId = customer.id
	
	await dbUser.save()

	return customer.id
}

router.get('/setupintent', asyncHandler(async (req, res, next) => {

	const customerId = res.locals.customerId

	// Triggers authentication if needed
	const setupIntent = await stripe.setupIntents.create({ usage: 'off_session' })

	res.send({ clientSecret: setupIntent.client_secret })
}))


router.post('/upgrade', asyncHandler(async (req, res, next) => {

	const token 		= req.body.token
	const couponCode 	= req.body.coupon
	const planId 		= req.body.upgradePlan

	// These two are most probably undefined 
	const subscriptionId = res.locals.subscriptionId
	let customerId 	= res.locals.customerId

	if (!customerId && !token) return next("Sorry! We need a credit card to subscribe you.")

	// If the customer doesn't have card or isn't a Stripe customer
	if (token) { 
		try {
			customerId = await addCardToCustomer(req.user, customerId, null, token)
		} catch(e) {
			console.error(e)
			return next("Sorry, we couldn't process your credit card. Please check with your bank.")
		}
	}

	let user = await options.mongoUser.findById(req.user.id).exec()

	const plan = options.plans.find(plan => plan.id === planId)
	if (!plan) return next('Invalid plan.')

	// If we supplied a coupon
	let coupon = null
	if (options.coupons && options.coupons.find(c => c.code === couponCode)) {
		coupon = couponCode
	}

	try {

		if (subscriptionId) {

			// https://stripe.com/docs/billing/subscriptions/upgrading-downgrading

			var subscription = await stripe.subscriptions.retrieve(subscriptionId)
			subscription = await stripe.subscriptions.update(subscriptionId, {
				coupon: coupon || undefined,
				items: [{
					id: subscription.items.data[0].id,
					plan: plan.stripeId,
				}],
				expand: ['latest_invoice.payment_intent'],
				metadata: {
					planId: planId
				}
			})

		} else {

			var subscription = await stripe.subscriptions.create({
									coupon: coupon || undefined,
									customer: customerId,
									trial_from_plan: true,
									payment_behavior: 'allow_incomplete',  // For legacy API versions
									items: [{ plan: plan.stripeId }],
									expand: ['latest_invoice.payment_intent'],
									metadata: {
										planId: planId
									}
								})
		}
	} catch(e) {
		console.error(e)
		return next("Error subscribing you to the corrrect plan. Please contact support.")
	}

	// So the user can start using the app ASAP
	user.plan = planId
	user.stripe.subscriptionId = subscription.id
	user.stripe.subscriptionItems = subscription.items.data.map(i => {
		return { 
			plan: i.plan.id, 
			id: i.id 
		}
	})

	await user.save()

	// That means it requires SCA auth
	// Depending if on-session or off-session
	// Either waiting for Card saving confirmation or direct Payment confirmation
	if (subscription.pending_setup_intent) {

		var intent = subscription.pending_setup_intent
		var action = 'handleCardSetup'
	
	} else if (subscription.latest_invoice.payment_intent) {
	
		var intent = subscription.latest_invoice.payment_intent
		var action = 'handleCardPayment'
	
	} else if (subscription.status === 'incomplete') {
	
		return next("We couldn't complete the transaction.")
	}

	// Means user need to do SCA/3DSecure shit to complete payment
	// "requires_source_action" and "requires_source" are deprecated, only for old API versions

	// Nothing to do anymore
	if (!intent || intent.status === 'succeeded') return res.send({})

	if (['requires_action', 'requires_source_action'].includes(intent.status)) {

		let secret = intent.client_secret
		
		return res.send({ actionRequired: action, clientSecret: secret })
	
	} else if (['requires_payment_method', 'requires_source'].includes(intent.status)) {
		
		return next('Please try with another card.')
	} 

	next('Unknown error with your subscription. Please try with another card.')

}))


router.post('/card', asyncHandler(async (req, res, next) => {

	const paymentMethodId = req.body.paymentMethodId
	const customerId = res.locals.customerId

	await addCardToCustomer(req.user, customerId, paymentMethodId)

	res.send({})
}))

router.get('/removecard', asyncHandler(async (req, res, next) => {

	const paymentMethodId = req.query.id

	await stripe.paymentMethods.detach(paymentMethodId)

	res.redirect(options.accountPath)
}))

router.get('/setcarddefault', asyncHandler(async (req, res, next) => {

	const paymentMethodId = req.query.id

	await stripe.customers.update(res.locals.customerId, { 
		invoice_settings: {
			default_payment_method: paymentMethodId
		} 
	})

	res.redirect(options.accountPath)
}))


router.get('/chooseplan', asyncHandler(async (req, res, next) => {

	const customerId = res.locals.customerId

	let data = await billingInfos(customerId, req.user, "choosepage", false)

	data.redirect = options.choosePlanRedirect

	const pageOptions = options.pages && options.pages.choosePlan ? options.pages.choosePlan : {}


	let options = data

	if (req.user) {
		options.subtitle = pageOptions.loggedSubtitle
		options.title = pageOptions.loggedTitle || "Select a plan"
	} else {
		options.subtitle = pageOptions.subtitle
		options.title = pageOptions.title || "Select a plan"
	}

	res.render(__dirname + '/views/choosePlan', options)
}))


router.get('/cancelsubscription', asyncHandler(async (req, res, next) => {

	let user = await options.mongoUser.findById(req.user.id).exec()

	const subscriptionId = res.locals.subscriptionId

	await stripe.subscriptions.update(subscriptionId, {
 		cancel_at_period_end: true
 	})

 	user.stripe.canceled = true
	user.save()

	res.redirect(options.accountPath)
}))

router.get('/resumesubscription', asyncHandler(async (req, res, next) => {

	const subscriptionId = res.locals.subscriptionId

	let user = await options.mongoUser.findById(req.user.id).exec()

	await stripe.subscriptions.update(subscriptionId, {
 		cancel_at_period_end: false
 	})

	user.stripe.canceled = false
	user.save()

	res.redirect(options.accountPath)
}))

router.get('/billing.js', (req, res, next) => {
	res.sendFile(__dirname+'/billing.js')
})

module.exports = (opts) => {
	if (opts) options = opts

	sendMail = options.sendMail || function () {}
	options.plans = options.plans || []
	
	options.accountPath = options.accountPath || '/account#billing'

	return router
}