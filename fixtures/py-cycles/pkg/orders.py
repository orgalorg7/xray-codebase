from pkg import customers


def order_total(order):
    return sum(order["items"]) - customers.discount(order["customer"])


def orders_for(customer_id):
    return [o for o in ORDERS if o["customer"] == customer_id]


ORDERS = []
