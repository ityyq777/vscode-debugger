"""
Test Flask Application for Debugging
"""

from flask import Flask, request, jsonify

app = Flask(__name__)

# In-memory data store
users = {
    1: {"id": 1, "name": "Alice", "email": "alice@example.com"},
    2: {"id": 2, "name": "Bob", "email": "bob@example.com"},
    3: {"id": 3, "name": "Charlie", "email": "charlie@example.com"},
}


@app.route("/")
def index():
    return jsonify({"message": "Welcome to the test API", "version": "1.0"})


@app.route("/users", methods=["GET"])
def get_users():
    return jsonify({"users": list(users.values())})


@app.route("/users/<int:user_id>", methods=["GET"])
def get_user(user_id):
    user = users.get(user_id)
    if user:
        return jsonify(user)
    return jsonify({"error": "User not found"}), 404


@app.route("/users", methods=["POST"])
def create_user():
    data = request.get_json()
    new_id = max(users.keys()) + 1 if users else 1
    new_user = {
        "id": new_id,
        "name": data.get("name"),
        "email": data.get("email"),
    }
    users[new_id] = new_user
    return jsonify(new_user), 201


@app.route("/users/<int:user_id>", methods=["PUT"])
def update_user(user_id):
    if user_id not in users:
        return jsonify({"error": "User not found"}), 404

    data = request.get_json()
    users[user_id].update(data)
    return jsonify(users[user_id])


@app.route("/users/<int:user_id>", methods=["DELETE"])
def delete_user(user_id):
    if user_id not in users:
        return jsonify({"error": "User not found"}), 404

    deleted = users.pop(user_id)
    return jsonify({"message": f"User {deleted['name']} deleted"})


@app.route("/echo", methods=["POST"])
def echo():
    data = request.get_json()
    return jsonify({"echo": data})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "healthy"})


if __name__ == "__main__":
    print("Starting test Flask app...")
    print("Try these endpoints:")
    print("  GET    /           - Welcome message")
    print("  GET    /users       - List all users")
    print("  GET    /users/1     - Get user by ID")
    print("  POST   /users       - Create new user")
    print("  PUT    /users/1     - Update user")
    print("  DELETE /users/1     - Delete user")
    print("  POST   /echo        - Echo back JSON")
    print("  GET    /health      - Health check")
    print()
    app.run(host="127.0.0.1", port=5000, debug=True)
