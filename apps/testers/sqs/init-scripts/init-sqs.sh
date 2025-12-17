#!/bin/bash

# Create the orders queue
awslocal sqs create-queue --queue-name orders

echo "SQS queue 'orders' created successfully!"
