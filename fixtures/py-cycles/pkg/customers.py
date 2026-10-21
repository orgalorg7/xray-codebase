def discount(customer_id):
    # Deferred import: breaks the cycle at runtime, but the dependency is still there.
    from pkg.orders import orders_for

    return 5 if len(orders_for(customer_id)) > 3 else 0
